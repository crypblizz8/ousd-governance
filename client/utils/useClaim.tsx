import { useState, useEffect } from "react";
import { BigNumber } from "ethers";
import { useStore } from "utils/store";
import useConnectSigner from "utils/useConnectSigner";
import { decimal18Bn, sleep } from "utils";
import numeral from "numeraljs";
import useTotalBalances from "utils/useTotalBalances";

const useClaim = () => {
  const emptyClaimState = {
    optional: { hasClaim: false },
    mandatory: { hasClaim: false },
  };
  const [claim, setClaim] = useState(emptyClaimState);
  const [loaded, setLoaded] = useState(false);
  const [distributorData, setDistributorData] = useState({});
  const [totalSupplyVeOgv, setTotalSupplyVeOgv] = useState(null);
  const [totalSupplyVeOgvAdjusted, setTotalSupplyVeOgvAdjusted] =
    useState(null);
  const { address, contracts, web3Provider, rpcProvider } = useStore();
  const hasClaim = claim.optional.hasClaim || claim.mandatory.hasClaim;
  /*
   * ready -> ready to start claiming
   * waiting-for-user -> waiting for user to confirm the transaction
   * waiting-for-network -> waiting for nodes to mine the transaction
   * claimed -> already claimed
   */
  const [mandatoryClaimState, setMandatoryClaimState] = useState("ready");
  const [optionalClaimState, setOptionalClaimState] = useState("ready");

  const [mandatoryTxReceipt, setMandatoryTxReceipt] = useState("");
  const [optionalTxReceipt, setOptionalTxReceipt] = useState("");

  const maybeConvertToBn = (amount) => {
    if (typeof amount !== "object" || !amount || amount.hex === undefined)
      return null;

    return BigNumber.from(amount.hex);
  };

  const { reloadTotalBalances } = useTotalBalances();

  useEffect(() => {
    const getClaim = async () => {
      setLoaded(false);
      const api = `/api/claim?account=${address}`;
      const res = await fetch(api);

      const claim = await res.json();

      if (!claim.optional.hasClaim && !claim.mandatory.hasClaim) {
        // nothing else to fetch related to claims.
        setLoaded(true);
      } else {
        const transformClaim = (claim) => {
          claim.amount = maybeConvertToBn(claim.amount);
          Object.keys(claim.split).map((key) => {
            claim.split[key] = maybeConvertToBn(claim.split[key]);
          });

          return claim;
        };

        claim.optional = transformClaim(claim.optional);
        claim.mandatory = transformClaim(claim.mandatory);
      }

      setClaim(claim);
    };

    getClaim();

    return () => setClaim(emptyClaimState);
  }, [address]);

  useEffect(() => {
    const loadTotalSupplyVeOGV = async () => {
      if (!contracts.loaded) {
        return;
      }
      try {
        const totalSupplyBn = await contracts.OgvStaking.totalSupply();
        setTotalSupplyVeOgv(totalSupplyBn);
        // TODO: verify this that we need to set some minimal total supply. Otherwise the first couple
        // of claimers will see insane reward amounts
        const minTotalSupply = numeral(100000000); // 100m of OGV
        const totalSupply = numeral(totalSupplyBn.div(decimal18Bn).toString());
        setTotalSupplyVeOgvAdjusted(Math.max(totalSupply, minTotalSupply));
      } catch (error) {
        console.error(`Can not fetch veOgv total supply:`, error);
      }
    };
    loadTotalSupplyVeOGV();
  }, [contracts]);

  useEffect(() => {
    if (
      !contracts.loaded ||
      !(claim.optional.hasClaim || claim.mandatory.hasClaim)
    ) {
      return;
    }

    const readDistributor = async (distContract, claim, claimStateSetter) => {
      const isClaimed = await distContract.isClaimed(claim.index);
      if (isClaimed) {
        claimStateSetter("claimed");
      }
      return {
        isClaimed,
        isValid: await distContract.isProofValid(
          claim.index,
          claim.amount,
          address,
          claim.proof
        ),
      };
    };

    setDistributorData({});
    setLoaded(false);

    const setupDistributors = async () => {
      try {
        const distData = {};

        if (claim.optional.hasClaim) {
          let distributor = await readDistributor(
            contracts.OptionalDistributor,
            claim.optional,
            setOptionalClaimState
          );

          distData.optional = {
            ...distributor,
            claim: async (duration) => {
              setOptionalClaimState("waiting-for-user");
              let claimResult;
              try {
                claimResult = await (
                  await useConnectSigner(
                    contracts.OptionalDistributor,
                    web3Provider
                  )
                )["claim(uint256,uint256,bytes32[],uint256)"](
                  claim.optional.index,
                  claim.optional.amount,
                  claim.optional.proof,
                  duration,
                  // 278048 * 1.5
                  { gasLimit: 417072 }
                );
                setOptionalTxReceipt(claimResult.hash);
              } catch (e) {
                setOptionalClaimState("ready");
                throw e;
              }

              setOptionalClaimState("waiting-for-network");
              let receipt;
              try {
                receipt = await rpcProvider.waitForTransaction(
                  claimResult.hash
                );
                // sleep for 5 seconds on development so it is more noticeable
                if (process.env.NODE_ENV === "development") {
                  await sleep(5000);
                }
              } catch (e) {
                setOptionalClaimState("ready");
                setOptionalTxReceipt("");
                throw e;
              }

              if (receipt.status === 1) {
                setOptionalClaimState("claimed");
                reloadTotalBalances();
              } else {
                setOptionalClaimState("ready");
              }

              return receipt;
            },
          };
        }

        if (claim.mandatory.hasClaim) {
          let distributor = await readDistributor(
            contracts.MandatoryDistributor,
            claim.mandatory,
            setMandatoryClaimState
          );

          distData.mandatory = {
            ...distributor,
            claim: async () => {
              setMandatoryClaimState("waiting-for-user");
              let claimResult;
              try {
                claimResult = await (
                  await useConnectSigner(
                    contracts.MandatoryDistributor,
                    web3Provider
                  )
                )["claim(uint256,uint256,bytes32[])"](
                  claim.mandatory.index,
                  claim.mandatory.amount,
                  claim.mandatory.proof,
                  // 498316 * 1.5
                  { gasLimit: 747474 }
                );
                setMandatoryTxReceipt(claimResult.hash);
              } catch (e) {
                setMandatoryClaimState("ready");
                throw e;
              }

              setMandatoryClaimState("waiting-for-network");
              let receipt;
              try {
                receipt = await rpcProvider.waitForTransaction(
                  claimResult.hash
                );
                // sleep for 5 seconds on development so it is more noticeable
                if (process.env.NODE_ENV === "development") {
                  await sleep(5000);
                }
              } catch (e) {
                setMandatoryClaimState("ready");
                setMandatoryTxReceipt("");
                throw e;
              }

              if (receipt.status === 1) {
                setMandatoryClaimState("claimed");
                reloadTotalBalances();
              } else {
                setMandatoryClaimState("ready");
              }

              return receipt;
            },
          };
        }

        setLoaded(true);
        setDistributorData(distData);
      } catch (error) {
        console.error("Error fetching contract distribution state:", error);
      }
    };

    setupDistributors();
  }, [address, contracts, claim, web3Provider]);

  return {
    optional: {
      state: optionalClaimState,
      ...claim.optional,
      ...distributorData.optional,
      receipt: optionalTxReceipt,
    },
    mandatory: {
      state: mandatoryClaimState,
      ...claim.mandatory,
      ...distributorData.mandatory,
      receipt: mandatoryTxReceipt,
    },
    staking: {
      // total supply adjusted for APY, with min amount - type: numeral
      totalSupplyVeOgvAdjusted: totalSupplyVeOgvAdjusted,
      // actual totalSupply - type: BigNumber
      totalSupplyVeOgv: totalSupplyVeOgv,
    },
    hasClaim,
    loaded,
  };
};

export default useClaim;

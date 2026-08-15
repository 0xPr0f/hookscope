// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";

/// @title ProtocolScenarioRouter
/// @notice A pinned, reviewed Uniswap-derived scenario harness for generated
///         PoolManager observations. It is not audited, and it is not a
///         production router.
///
/// @dev Purpose: drive real `PoolManager.unlock` / `unlockCallback` flow against
///      a deployed pool and hook without depending on whichever custom router
///      produced a historical transaction. Historical replay remains a separate,
///      independent evidence path; nothing here substitutes for it.
///
///      Settlement is deliberately ERC-6909-only. Every debt is paid by burning
///      the harness's own claim balance and every credit is taken as minted
///      claims, so a scenario never writes an ERC-20 balance or allowance slot.
///      The synthetic environment is therefore declared by exactly one storage
///      overlay — the harness's claim balances inside PoolManager — instead of
///      per-token layouts that cannot be derived reliably.
///
///      Consequence, stated plainly: these scenarios exercise pool, hook,
///      callback, transient-accounting, fee and settlement behavior. They do not
///      exercise the selected token's ordinary ERC-20 transfer path.
contract ProtocolScenarioRouter is SafeCallback {
    using CurrencySettler for Currency;
    // Deltas live in transient storage; this is the accessor the official test
    // routers use, so the harness reads settlement state the same way they do.
    using TransientStateLibrary for IPoolManager;

    enum Operation {
        Swap,
        ModifyLiquidity,
        Donate
    }

    struct Step {
        Operation operation;
        PoolKey key;
        // Swap
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        // ModifyLiquidity
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
        // Donate
        uint256 amount0;
        uint256 amount1;
        bytes hookData;
    }

    /// @notice A currency still owed to or by the harness after a step settled.
    error UnsettledDelta(address currency, int256 delta);

    constructor(IPoolManager manager) SafeCallback(manager) {}

    /// @notice Runs one or more operations inside a single unlock, mirroring how
    ///         a production router batches work.
    /// @dev Returning the per-step deltas lets the caller assert settlement
    ///      without re-deriving it from traces.
    function run(Step[] calldata steps) external returns (BalanceDelta[] memory deltas) {
        return abi.decode(poolManager.unlock(abi.encode(steps)), (BalanceDelta[]));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        Step[] memory steps = abi.decode(data, (Step[]));
        BalanceDelta[] memory deltas = new BalanceDelta[](steps.length);

        for (uint256 index = 0; index < steps.length; index++) {
            Step memory step = steps[index];

            if (step.operation == Operation.Swap) {
                deltas[index] = poolManager.swap(
                    step.key,
                    SwapParams({
                        zeroForOne: step.zeroForOne,
                        amountSpecified: step.amountSpecified,
                        sqrtPriceLimitX96: step.sqrtPriceLimitX96
                    }),
                    step.hookData
                );
            } else if (step.operation == Operation.ModifyLiquidity) {
                (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
                    step.key,
                    ModifyLiquidityParams({
                        tickLower: step.tickLower,
                        tickUpper: step.tickUpper,
                        liquidityDelta: step.liquidityDelta,
                        salt: step.salt
                    }),
                    step.hookData
                );
                deltas[index] = callerDelta;
            } else {
                deltas[index] = poolManager.donate(step.key, step.amount0, step.amount1, step.hookData);
            }

            // Settle after every step so a sequence cannot mask an intermediate
            // imbalance behind a later opposing one.
            _settle(step.key.currency0);
            _settle(step.key.currency1);
        }

        return abi.encode(deltas);
    }

    /// @dev Pays debts by burning claims and takes credits as claims, then
    ///      asserts the currency reached exactly zero. The unlock would revert on
    ///      a non-zero delta anyway; failing here names the currency instead.
    function _settle(Currency currency) private {
        int256 delta = poolManager.currencyDelta(address(this), currency);
        if (delta < 0) {
            currency.settle(poolManager, address(this), uint256(-delta), true);
        } else if (delta > 0) {
            currency.take(poolManager, address(this), uint256(delta), true);
        }

        int256 remaining = poolManager.currencyDelta(address(this), currency);
        if (remaining != 0) revert UnsettledDelta(Currency.unwrap(currency), remaining);
    }
}

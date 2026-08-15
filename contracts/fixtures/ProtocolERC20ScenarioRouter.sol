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

/// @title ProtocolERC20ScenarioRouter
/// @notice The ERC-20 settlement lane of the generated scenario harness. Pinned
///         and reviewed, not audited, and not a production router.
///
/// @dev This is the sibling of `ProtocolScenarioRouter`, which settles purely in
///      ERC-6909 claims. That one is the pool/hook mechanics baseline: it never
///      touches a token balance or allowance, so it stays available even when an
///      actor cannot be funded. This one deliberately does the opposite.
///
///      Debts are paid with `settle(..., false)`, which routes through
///      `CurrencySettler` to `token.transferFrom(payer, poolManager, amount)`.
///      Credits are taken with `take(..., false)`, which routes through
///      `poolManager.take(currency, recipient, amount)` and moves real ERC-20
///      out of the PoolManager. Both therefore execute the selected token's own
///      code — its fees, its blocklists, its caller and recipient checks.
///
///      Payer and recipient are explicit and are carried into the unlock
///      callback rather than defaulting to the harness. The harness must never
///      be the ERC-20 owner: the point of this lane is to observe what happens
///      to a real funded account, and using the harness's own balance would
///      quietly reintroduce a synthetic owner.
///
///      Comparing the same scenario across both lanes is the actual signal. A
///      claims run that passes while this one reverts isolates the failure to
///      the token settlement path; both failing alike points at the pool or the
///      hook instead.
///
///      Native input is supplied as `msg.value`. `CurrencySettler.settle` pays
///      it from this contract, so `run` accounts for the balance that existed
///      before the call, refuses to consume any of that pre-existing balance,
///      and refunds unused value to the caller. That makes a native round-trip
///      leg state-linked to the value the actor actually received rather than
///      quietly spending the harness's synthetic fork funding. A native credit
///      reaches `recipient`, since `PoolManager.take` transfers to that address.
contract ProtocolERC20ScenarioRouter is SafeCallback {
    using CurrencySettler for Currency;
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
    /// @notice Refuses a run that would make the harness its own ERC-20 owner.
    error HarnessCannotBePayerOrRecipient();
    /// @notice Refuses a run with an unset payer or recipient.
    error PayerAndRecipientRequired();
    /// @notice Native settlement consumed balance that pre-dated this call.
    error NativeFundingShortfall(uint256 amount);
    /// @notice Unused native input could not be returned to the caller.
    error NativeRefundFailed();

    constructor(IPoolManager manager) SafeCallback(manager) {}

    /// @notice Runs operations inside one unlock, settling in real ERC-20.
    /// @param payer Account debited via `transferFrom`; must have approved this
    ///        harness for the input token.
    /// @param recipient Account credited via `PoolManager.take`.
    /// @dev Returning per-step deltas lets a caller compare requested amounts
    ///      against observed balance movement without re-deriving them.
    function run(Step[] calldata steps, address payer, address recipient)
        external
        payable
        returns (BalanceDelta[] memory deltas)
    {
        if (payer == address(0) || recipient == address(0)) revert PayerAndRecipientRequired();
        if (payer == address(this) || recipient == address(this)) revert HarnessCannotBePayerOrRecipient();

        // `address(this).balance` already includes msg.value here. Remembering
        // the balance from before this call lets us prove native settlement did
        // not fall back to the harness's injected fork funding.
        uint256 balanceBefore = address(this).balance - msg.value;
        deltas = abi.decode(poolManager.unlock(abi.encode(steps, payer, recipient)), (BalanceDelta[]));

        uint256 balanceAfter = address(this).balance;
        if (balanceAfter < balanceBefore) revert NativeFundingShortfall(balanceBefore - balanceAfter);
        uint256 refund = balanceAfter - balanceBefore;
        if (refund != 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert NativeRefundFailed();
        }
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (Step[] memory steps, address payer, address recipient) =
            abi.decode(data, (Step[], address, address));
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

            // Settle after every step, matching the claims lane, so a sequence
            // cannot hide an intermediate imbalance behind a later opposing one.
            _settle(step.key.currency0, payer, recipient);
            _settle(step.key.currency1, payer, recipient);
        }

        return abi.encode(deltas);
    }

    /// @dev Pays debts by pulling real ERC-20 from `payer` and takes credits as
    ///      real ERC-20 to `recipient`, then asserts the currency reached zero.
    ///      The unlock would revert on a non-zero delta anyway; failing here
    ///      names the currency instead.
    ///
    ///      A token that takes a fee on transfer makes `settle` deliver less than
    ///      the debt. That surfaces here as a still-negative delta and reverts
    ///      with the currency named, which is the honest outcome: the requested
    ///      amount and the amount the pool actually received differ, and the
    ///      caller records both rather than the harness papering over it.
    function _settle(Currency currency, address payer, address recipient) private {
        int256 delta = poolManager.currencyDelta(address(this), currency);
        if (delta < 0) {
            currency.settle(poolManager, payer, uint256(-delta), false);
        } else if (delta > 0) {
            currency.take(poolManager, recipient, uint256(delta), false);
        }

        int256 remaining = poolManager.currencyDelta(address(this), currency);
        if (remaining != 0) revert UnsettledDelta(Currency.unwrap(currency), remaining);
    }
}

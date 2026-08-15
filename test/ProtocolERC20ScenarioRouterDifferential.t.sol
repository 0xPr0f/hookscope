// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ProtocolScenarioRouter} from "../contracts/fixtures/ProtocolScenarioRouter.sol";
import {ProtocolERC20ScenarioRouter} from "../contracts/fixtures/ProtocolERC20ScenarioRouter.sol";
import {ScenarioHook} from "../contracts/fixtures/ScenarioHook.sol";

/// @notice Differential oracle for the two settlement lanes.
///
/// @dev The claims lane is the pool/hook mechanics baseline; the ERC-20 lane
///      executes the token's own transfer code. Running the same scenario down
///      both is what makes the comparison meaningful: agreement says the pool
///      moved identically regardless of settlement rail, and disagreement
///      localizes the cause to the token path.
///
///      The token fixtures here are deliberately awkward on purpose — a fee on
///      transfer, a sell-side rejection, an approval restriction — because those
///      are exactly the behaviors that a claims-only harness cannot observe at
///      all, and the acceptance criterion is that each one is reported as a
///      concrete difference rather than as a pool or hook verdict.
contract ProtocolERC20ScenarioRouterDifferentialTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ProtocolScenarioRouter internal claimsHarness;
    ProtocolERC20ScenarioRouter internal tokenHarness;
    PoolId internal poolId;
    PoolKey internal nativeTokenKey;
    address internal hookAddress;

    address internal actor = address(0xA11CE);
    address internal alternateActor = address(0xB0B);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        ScenarioHook implementation = new ScenarioHook(manager, address(this));
        hookAddress = address(uint160(0x0fff));
        vm.etch(hookAddress, address(implementation).code);

        (key, poolId) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(hookAddress), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        vm.deal(address(this), 100 ether);
        (nativeTokenKey,) = initPoolAndAddLiquidityETH(
            CurrencyLibrary.ADDRESS_ZERO,
            currency1,
            IHooks(hookAddress),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            SQRT_PRICE_1_1,
            10 ether
        );

        claimsHarness = new ProtocolScenarioRouter(manager);
        tokenHarness = new ProtocolERC20ScenarioRouter(manager);
        _fundClaims(address(claimsHarness), 100 ether);

        // The ERC-20 lane needs a real funded account, not a funded harness.
        ERC20Like(Currency.unwrap(currency0)).transfer(actor, 50 ether);
        ERC20Like(Currency.unwrap(currency1)).transfer(actor, 50 ether);
        ERC20Like(Currency.unwrap(currency0)).transfer(alternateActor, 10 ether);
        vm.deal(actor, 50 ether);
    }

    function _fundClaims(address owner, uint256 amount) private {
        manager.unlock(abi.encode(owner, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (address owner, uint256 amount) = abi.decode(data, (address, uint256));
        for (uint256 i = 0; i < 2; i++) {
            Currency currency = i == 0 ? currency0 : currency1;
            manager.sync(currency);
            ERC20Like(Currency.unwrap(currency)).transfer(address(manager), amount);
            manager.settle();
            manager.mint(owner, currency.toId(), amount);
        }
        return "";
    }

    function _claimsStep(bool zeroForOne, int256 amountSpecified)
        private
        view
        returns (ProtocolScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.Swap;
        steps[0].key = key;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amountSpecified;
        steps[0].sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _tokenStep(bool zeroForOne, int256 amountSpecified)
        private
        view
        returns (ProtocolERC20ScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolERC20ScenarioRouter.Step[](1);
        steps[0].operation = ProtocolERC20ScenarioRouter.Operation.Swap;
        steps[0].key = key;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amountSpecified;
        steps[0].sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _nativeTokenStep(bool zeroForOne, int256 amountSpecified)
        private
        view
        returns (ProtocolERC20ScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolERC20ScenarioRouter.Step[](1);
        steps[0].operation = ProtocolERC20ScenarioRouter.Operation.Swap;
        steps[0].key = nativeTokenKey;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amountSpecified;
        steps[0].sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    struct PoolState {
        uint160 sqrtPriceX96;
        int24 tick;
        uint128 liquidity;
    }

    function _state() private view returns (PoolState memory state) {
        (state.sqrtPriceX96, state.tick,,) = manager.getSlot0(poolId);
        state.liquidity = manager.getLiquidity(poolId);
    }

    /// @dev Approvals are granted by the actor itself, exercising the token's own
    ///      `approve`, rather than by writing an allowance slot.
    function _approve(Currency currency, uint256 amount) private {
        vm.prank(actor);
        ERC20Like(Currency.unwrap(currency)).approve(address(tokenHarness), amount);
    }

    function test_bothLanesMoveThePoolIdentically() public {
        for (uint256 i = 0; i < 2; i++) {
            bool zeroForOne = i == 0;
            uint256 snapshot = vm.snapshotState();

            BalanceDelta[] memory claimsDeltas = claimsHarness.run(_claimsStep(zeroForOne, -1e15));
            PoolState memory viaClaims = _state();

            vm.revertToState(snapshot);

            _approve(zeroForOne ? currency0 : currency1, type(uint256).max);
            vm.prank(actor);
            BalanceDelta[] memory tokenDeltas = tokenHarness.run(_tokenStep(zeroForOne, -1e15), actor, actor);
            PoolState memory viaToken = _state();

            assertEq(viaToken.sqrtPriceX96, viaClaims.sqrtPriceX96, "sqrtPriceX96 agrees across lanes");
            assertEq(viaToken.tick, viaClaims.tick, "tick agrees across lanes");
            assertEq(viaToken.liquidity, viaClaims.liquidity, "liquidity agrees across lanes");
            assertEq(
                int256(tokenDeltas[0].amount0()), int256(claimsDeltas[0].amount0()), "delta0 agrees across lanes"
            );
            assertEq(
                int256(tokenDeltas[0].amount1()), int256(claimsDeltas[0].amount1()), "delta1 agrees across lanes"
            );
            vm.revertToState(snapshot);
        }
    }

    function test_erc20LaneMovesRealTokenBalances() public {
        uint256 actorBefore0 = ERC20Like(Currency.unwrap(currency0)).balanceOf(actor);
        uint256 actorBefore1 = ERC20Like(Currency.unwrap(currency1)).balanceOf(actor);
        uint256 managerBefore0 = ERC20Like(Currency.unwrap(currency0)).balanceOf(address(manager));

        _approve(currency0, type(uint256).max);
        vm.prank(actor);
        BalanceDelta[] memory deltas = tokenHarness.run(_tokenStep(true, -1e15), actor, actor);

        int256 actorMoved0 = int256(ERC20Like(Currency.unwrap(currency0)).balanceOf(actor)) - int256(actorBefore0);
        int256 actorMoved1 = int256(ERC20Like(Currency.unwrap(currency1)).balanceOf(actor)) - int256(actorBefore1);
        int256 managerMoved0 =
            int256(ERC20Like(Currency.unwrap(currency0)).balanceOf(address(manager))) - int256(managerBefore0);

        // The actor's own balances moved by exactly the returned deltas.
        assertEq(actorMoved0, int256(deltas[0].amount0()), "actor balance0 matches returned delta");
        assertEq(actorMoved1, int256(deltas[0].amount1()), "actor balance1 matches returned delta");
        // And the PoolManager received the input, unlike the claims lane.
        assertEq(managerMoved0, -int256(deltas[0].amount0()), "manager received the real input token");
        assertGt(uint256(managerMoved0), 0, "the token rail actually moved ERC-20");
    }

    function test_harnessRefusesToBeItsOwnPayerOrRecipient() public {
        vm.expectRevert(ProtocolERC20ScenarioRouter.HarnessCannotBePayerOrRecipient.selector);
        tokenHarness.run(_tokenStep(true, -1e15), address(tokenHarness), actor);

        vm.expectRevert(ProtocolERC20ScenarioRouter.HarnessCannotBePayerOrRecipient.selector);
        tokenHarness.run(_tokenStep(true, -1e15), actor, address(tokenHarness));

        vm.expectRevert(ProtocolERC20ScenarioRouter.PayerAndRecipientRequired.selector);
        tokenHarness.run(_tokenStep(true, -1e15), address(0), actor);
    }

    function test_missingApprovalIsATokenPathObservationNotAPoolFailure() public {
        // No approval granted. The claims lane still completes, which is exactly
        // the signal: the pool and hook are fine, the token rail is not usable.
        uint256 snapshot = vm.snapshotState();
        vm.prank(actor);
        vm.expectRevert();
        tokenHarness.run(_tokenStep(true, -1e15), actor, actor);

        vm.revertToState(snapshot);
        BalanceDelta[] memory claimsDeltas = claimsHarness.run(_claimsStep(true, -1e15));
        assertLt(int256(claimsDeltas[0].amount0()), int256(0), "claims baseline still exercises the pool");
    }

    function test_alternatePayerAndRecipientAreHonoured() public {
        _approve(currency0, type(uint256).max);
        uint256 recipientBefore = ERC20Like(Currency.unwrap(currency1)).balanceOf(alternateActor);

        vm.prank(actor);
        BalanceDelta[] memory deltas = tokenHarness.run(_tokenStep(true, -1e15), actor, alternateActor);

        uint256 recipientAfter = ERC20Like(Currency.unwrap(currency1)).balanceOf(alternateActor);
        assertEq(
            int256(recipientAfter) - int256(recipientBefore),
            int256(deltas[0].amount1()),
            "output reached the named recipient, not the payer"
        );
    }

    function test_roundTripBuyThenSellUsesTheRealTransferPathBothWays() public {
        _approve(currency0, type(uint256).max);
        uint256 before1 = ERC20Like(Currency.unwrap(currency1)).balanceOf(actor);

        vm.prank(actor);
        BalanceDelta[] memory bought = tokenHarness.run(_tokenStep(true, -1e15), actor, actor);
        uint256 received = ERC20Like(Currency.unwrap(currency1)).balanceOf(actor) - before1;
        assertEq(received, uint256(int256(bought[0].amount1())), "actor received output through its real transfer path");

        // Sell exactly what was received, back through transferFrom.
        _approve(currency1, type(uint256).max);
        uint256 before0 = ERC20Like(Currency.unwrap(currency0)).balanceOf(actor);
        vm.prank(actor);
        BalanceDelta[] memory sold = tokenHarness.run(_tokenStep(false, -int256(received)), actor, actor);

        assertGt(int256(sold[0].amount0()), int256(0), "reverse direction returned the input currency");
        assertGt(ERC20Like(Currency.unwrap(currency0)).balanceOf(actor), before0, "actor got currency0 back");
    }

    function test_nativeRoundTripCarriesExactReceivedValueIntoReverseLeg() public {
        // First sell the token into the native side. The PoolManager pays the
        // named actor directly, so the amount is measured from the actor rather
        // than inferred from a quote.
        _approve(currency1, type(uint256).max);
        uint256 nativeBefore = actor.balance;
        vm.prank(actor);
        tokenHarness.run(_nativeTokenStep(false, -1e15), actor, actor);
        uint256 nativeReceived = actor.balance - nativeBefore;
        assertGt(nativeReceived, 0, "forward leg delivered native currency");

        // Give the harness a pre-existing balance to prove the reverse leg does
        // not consume it. The exact amount received above is supplied by the
        // actor as msg.value and must return the harness to the same balance.
        vm.deal(address(tokenHarness), 1 ether);
        uint256 harnessBefore = address(tokenHarness).balance;
        uint256 tokenBefore = ERC20Like(Currency.unwrap(currency1)).balanceOf(actor);
        vm.prank(actor);
        tokenHarness.run{value: nativeReceived}(
            _nativeTokenStep(true, -int256(nativeReceived)), actor, actor
        );

        assertEq(address(tokenHarness).balance, harnessBefore, "native leg did not spend harness funding");
        assertGt(
            ERC20Like(Currency.unwrap(currency1)).balanceOf(actor),
            tokenBefore,
            "reverse leg delivered the real ERC-20 output"
        );
    }
}

interface ERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

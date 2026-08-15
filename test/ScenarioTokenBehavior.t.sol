// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ProtocolScenarioRouter} from "../contracts/fixtures/ProtocolScenarioRouter.sol";
import {ProtocolERC20ScenarioRouter} from "../contracts/fixtures/ProtocolERC20ScenarioRouter.sol";
import {ConfigurableScenarioToken} from "../contracts/fixtures/ScenarioTokens.sol";
import {ScenarioHook} from "../contracts/fixtures/ScenarioHook.sol";

/// @notice Acceptance cases for behaviors only the ERC-20 lane can observe.
///
/// @dev Each case asserts two things at once: that the token rail reports the
///      awkward behavior concretely, and that the claims baseline still passes.
///      That pairing is the whole point — it localizes the cause to the token
///      rather than producing a verdict about the pool or the hook.
contract ScenarioTokenBehaviorTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ProtocolScenarioRouter internal claimsHarness;
    ProtocolERC20ScenarioRouter internal tokenHarness;
    ConfigurableScenarioToken internal token;
    PoolId internal behaviorPoolId;
    PoolKey internal behaviorKey;
    Currency internal tokenCurrency;
    Currency internal plainCurrency;

    address internal actor = address(0xA11CE);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        ScenarioHook implementation = new ScenarioHook(manager, address(this));
        address hookAddress = address(uint160(0x0fff));
        vm.etch(hookAddress, address(implementation).code);

        token = new ConfigurableScenarioToken();
        token.mint(address(this), 1_000 ether);
        token.mint(actor, 100 ether);

        // currency0 must sort below currency1.
        Currency plain = currency0;
        Currency configurable = Currency.wrap(address(token));
        (behaviorKey.currency0, behaviorKey.currency1) =
            Currency.unwrap(configurable) < Currency.unwrap(plain) ? (configurable, plain) : (plain, configurable);
        tokenCurrency = configurable;
        plainCurrency = plain;
        behaviorKey.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG;
        behaviorKey.tickSpacing = 60;
        behaviorKey.hooks = IHooks(hookAddress);
        behaviorPoolId = behaviorKey.toId();

        manager.initialize(behaviorKey, SQRT_PRICE_1_1);

        // Seed liquidity while the token is still perfectly ordinary; the
        // awkward behavior is switched on per test, after setup.
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            behaviorKey,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 10 ether, salt: bytes32(0)}),
            ""
        );

        claimsHarness = new ProtocolScenarioRouter(manager);
        tokenHarness = new ProtocolERC20ScenarioRouter(manager);
        _fundClaims(address(claimsHarness), 50 ether);
    }

    function _fundClaims(address owner, uint256 amount) private {
        manager.unlock(abi.encode(owner, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (address owner, uint256 amount) = abi.decode(data, (address, uint256));
        for (uint256 i = 0; i < 2; i++) {
            Currency currency = i == 0 ? behaviorKey.currency0 : behaviorKey.currency1;
            manager.sync(currency);
            ERC20Like(Currency.unwrap(currency)).transfer(address(manager), amount);
            manager.settle();
            manager.mint(owner, currency.toId(), amount);
        }
        return "";
    }

    /// @dev True when selling the configurable token, i.e. paying it in.
    function _sellTokenDirection() private view returns (bool) {
        return Currency.unwrap(tokenCurrency) == Currency.unwrap(behaviorKey.currency0);
    }

    function _claimsStep(bool zeroForOne, int256 amount)
        private
        view
        returns (ProtocolScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.Swap;
        steps[0].key = behaviorKey;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amount;
        steps[0].sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _tokenStep(bool zeroForOne, int256 amount)
        private
        view
        returns (ProtocolERC20ScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolERC20ScenarioRouter.Step[](1);
        steps[0].operation = ProtocolERC20ScenarioRouter.Operation.Swap;
        steps[0].key = behaviorKey;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amount;
        steps[0].sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _approveBoth() private {
        vm.startPrank(actor);
        token.approve(address(tokenHarness), type(uint256).max);
        ERC20Like(Currency.unwrap(plainCurrency)).approve(address(tokenHarness), type(uint256).max);
        vm.stopPrank();
    }

    function test_standardTokenSucceedsOnBothLanesAndBothDirections() public {
        _approveBoth();
        ERC20Like(Currency.unwrap(plainCurrency)).transfer(actor, 10 ether);

        for (uint256 i = 0; i < 2; i++) {
            bool zeroForOne = i == 0;
            uint256 snapshot = vm.snapshotState();

            BalanceDelta[] memory viaClaims = claimsHarness.run(_claimsStep(zeroForOne, -1e15));
            vm.revertToState(snapshot);

            vm.prank(actor);
            BalanceDelta[] memory viaToken = tokenHarness.run(_tokenStep(zeroForOne, -1e15), actor, actor);

            assertEq(int256(viaToken[0].amount0()), int256(viaClaims[0].amount0()), "delta0 agrees");
            assertEq(int256(viaToken[0].amount1()), int256(viaClaims[0].amount1()), "delta1 agrees");
            vm.revertToState(snapshot);
        }
    }

    function test_transferFeeSurfacesAsRequestedVersusDeliveredDifference() public {
        _approveBoth();
        token.setTransferFeeBps(100); // 1%

        bool sellToken = _sellTokenDirection();
        uint256 requested = 1e15;

        // The claims baseline is unaffected: the fee lives in the token, and the
        // claims lane never calls it.
        uint256 snapshot = vm.snapshotState();
        BalanceDelta[] memory viaClaims = claimsHarness.run(_claimsStep(sellToken, -int256(requested)));
        assertLt(
            sellToken ? int256(viaClaims[0].amount0()) : int256(viaClaims[0].amount1()),
            int256(0),
            "claims baseline still swaps the requested input"
        );
        vm.revertToState(snapshot);

        // The token lane pays `requested` but the PoolManager receives less, so
        // the debt is never cleared and settlement names the currency.
        uint256 managerBefore = token.balanceOf(address(manager));
        vm.prank(actor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProtocolERC20ScenarioRouter.UnsettledDelta.selector,
                address(token),
                -int256(requested * 100 / 10_000)
            )
        );
        tokenHarness.run(_tokenStep(sellToken, -int256(requested)), actor, actor);

        // Nothing was left behind by the reverted attempt.
        assertEq(token.balanceOf(address(manager)), managerBefore, "reverted settlement moved no net balance");
    }

    function test_sellRestrictionBuysButCannotReverse() public {
        _approveBoth();
        ERC20Like(Currency.unwrap(plainCurrency)).transfer(actor, 10 ether);
        bool sellToken = _sellTokenDirection();

        // Buying the token still works: that path is PoolManager.take, not transferFrom.
        uint256 before = token.balanceOf(actor);
        vm.prank(actor);
        tokenHarness.run(_tokenStep(!sellToken, -1e15), actor, actor);
        assertGt(token.balanceOf(actor), before, "buy delivered the token to the actor");

        // Now block paying the token in to the PoolManager, i.e. block selling.
        token.setTransferFromToBlocked(address(manager), true);

        uint256 snapshot = vm.snapshotState();
        vm.prank(actor);
        vm.expectRevert(bytes("recipient blocked"));
        tokenHarness.run(_tokenStep(sellToken, -1e15), actor, actor);

        // The claims baseline sells without complaint, localizing the cause.
        vm.revertToState(snapshot);
        BalanceDelta[] memory viaClaims = claimsHarness.run(_claimsStep(sellToken, -1e15));
        assertLt(
            sellToken ? int256(viaClaims[0].amount0()) : int256(viaClaims[0].amount1()),
            int256(0),
            "claims baseline sells while the token rail refuses"
        );
    }

    function test_blockedSpenderIsATokenPathObservation() public {
        _approveBoth();
        token.setSpenderBlocked(address(tokenHarness), true);
        bool sellToken = _sellTokenDirection();

        uint256 snapshot = vm.snapshotState();
        vm.prank(actor);
        vm.expectRevert(bytes("spender blocked"));
        tokenHarness.run(_tokenStep(sellToken, -1e15), actor, actor);

        vm.revertToState(snapshot);
        BalanceDelta[] memory viaClaims = claimsHarness.run(_claimsStep(sellToken, -1e15));
        assertLt(
            sellToken ? int256(viaClaims[0].amount0()) : int256(viaClaims[0].amount1()),
            int256(0),
            "claims baseline unaffected by a caller-gated token"
        );
    }

    function test_silentlyRefusedApprovalIsObservable() public {
        token.setApprovalBlocked(actor, true);
        vm.prank(actor);
        bool granted = token.approve(address(tokenHarness), type(uint256).max);

        // The token returned false rather than reverting, so the allowance is
        // still zero. Reading it back is what makes the refusal observable.
        assertFalse(granted, "approve reported failure");
        assertEq(token.allowance(actor, address(tokenHarness)), 0, "allowance never changed");
    }

    function test_amountThresholdChangesOutcomeByAmountAlone() public {
        _approveBoth();
        token.setMinimumTransfer(1e16);
        bool sellToken = _sellTokenDirection();

        // Below the threshold the token refuses; above it the same scenario works.
        uint256 snapshot = vm.snapshotState();
        vm.prank(actor);
        vm.expectRevert(bytes("below minimum"));
        tokenHarness.run(_tokenStep(sellToken, -1e15), actor, actor);

        vm.revertToState(snapshot);
        vm.prank(actor);
        BalanceDelta[] memory larger = tokenHarness.run(_tokenStep(sellToken, -2e16), actor, actor);
        assertLt(
            sellToken ? int256(larger[0].amount0()) : int256(larger[0].amount1()),
            int256(0),
            "the larger amount cleared the token's own threshold"
        );
    }
}

interface ERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

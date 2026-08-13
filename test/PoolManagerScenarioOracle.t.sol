// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ScenarioHook} from "../contracts/fixtures/ScenarioHook.sol";

contract PoolManagerScenarioOracleTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    ScenarioHook internal hook;
    PoolId internal poolId;
    address internal participant;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        ScenarioHook implementation = new ScenarioHook(manager, address(this));
        // All swap/liquidity/donate callbacks plus all four return-delta flags.
        address hookAddress = address(uint160(0x0fff));
        vm.etch(hookAddress, address(implementation).code);
        hook = ScenarioHook(hookAddress);

        (key, poolId) = initPoolAndAddLiquidity(
            currency0,
            currency1,
            IHooks(hookAddress),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            SQRT_PRICE_1_1
        );

        participant = makeAddr("participant");
        MockERC20(Currency.unwrap(currency0)).mint(participant, 1e24);
        MockERC20(Currency.unwrap(currency1)).mint(participant, 1e24);
        vm.startPrank(participant);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function test_realPoolManagerRunsSwapLiquidityDonationAndSequenceCallbacks() public {
        hook.configureSwapFee(3000);
        hook.configureRouter(address(swapRouter));

        vm.prank(participant);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1e12, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(participant)
        );
        vm.prank(participant);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -1e12, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(participant)
        );
        vm.prank(participant);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: 1e6, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(participant)
        );

        donateRouter.donate(key, 100, 200, bytes("donation"));
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: -1e12, salt: 0}),
            bytes("remove")
        );

        ScenarioHook.Counts memory observed = hook.counts(poolId);
        assertEq(observed.beforeAddLiquidity, 1);
        assertEq(observed.afterAddLiquidity, 1);
        assertEq(observed.beforeRemoveLiquidity, 1);
        assertEq(observed.afterRemoveLiquidity, 1);
        assertEq(observed.beforeSwap, 3);
        assertEq(observed.afterSwap, 3);
        assertEq(observed.beforeDonate, 1);
        assertEq(observed.afterDonate, 1);
        assertEq(hook.lastRouter(), address(swapRouter));
        assertEq(hook.lastParticipant(), participant);
    }

    function test_directionAndRouterVariantsRemainVisible() public {
        hook.configureDirection(true);
        vm.expectRevert();
        swap(key, true, -100, bytes("blocked direction"));

        swap(key, false, -100, bytes("available direction"));

        PoolSwapTest otherRouter = new PoolSwapTest(manager);
        MockERC20(Currency.unwrap(currency0)).approve(address(otherRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(otherRouter), type(uint256).max);
        hook.configureDirection(false);
        hook.configureRouter(address(swapRouter));
        vm.expectRevert();
        otherRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -100, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("router variant")
        );
    }

    function test_nonZeroReturnDeltasSettleThroughPoolManager() public {
        hook.configureReturnDeltas(1, 1, 0, 0);
        vm.prank(participant);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -100, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(participant)
        );

        hook.configureReturnDeltas(0, 0, 1, 1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e12, salt: 0}),
            bytes("delta")
        );
    }

    function test_openAndRestrictedConfigurationPolicies() public {
        address observer = makeAddr("observer");
        vm.prank(observer);
        hook.configureRouter(address(0));
        assertEq(hook.allowedRouter(), address(0));

        hook.configurePolicy(true);
        vm.prank(observer);
        vm.expectRevert();
        hook.configureRouter(observer);

        hook.configureRouter(address(swapRouter));
        assertEq(hook.allowedRouter(), address(swapRouter));
    }
}

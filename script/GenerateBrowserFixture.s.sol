// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ScenarioHook} from "../contracts/fixtures/ScenarioHook.sol";

contract GenerateBrowserFixture is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant ACTOR = 0xa11ce00000000000000000000000000000000001;
    address internal constant OBSERVER = 0xb0b0000000000000000000000000000000000002;
    // All swap/liquidity/donate callbacks plus all four return-delta flags.
    address internal constant HOOK_ADDRESS = address(uint160(0x0fff));
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function run() external {
        vm.deal(ACTOR, 1e24);
        vm.deal(OBSERVER, 1e24);
        IPoolManager manager = IPoolManager(address(new PoolManager(ACTOR)));
        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        PoolSwapTest alternateSwapRouter = new PoolSwapTest(manager);
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(manager);
        PoolDonateTest donateRouter = new PoolDonateTest(manager);

        ScenarioHook implementation = new ScenarioHook(manager, ACTOR);
        vm.etch(HOOK_ADDRESS, address(implementation).code);
        ScenarioHook hook = ScenarioHook(HOOK_ADDRESS);

        MockERC20 tokenA = new MockERC20("Fixture A", "FXA", 18);
        MockERC20 tokenB = new MockERC20("Fixture B", "FXB", 18);
        (MockERC20 token0, MockERC20 token1) = address(tokenA) < address(tokenB)
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        token0.mint(ACTOR, 1e30);
        token1.mint(ACTOR, 1e30);

        vm.startPrank(ACTOR);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
        token0.approve(address(alternateSwapRouter), type(uint256).max);
        token1.approve(address(alternateSwapRouter), type(uint256).max);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        token0.approve(address(donateRouter), type(uint256).max);
        token1.approve(address(donateRouter), type(uint256).max);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(HOOK_ADDRESS)
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e18, salt: 0}),
            bytes("")
        );

        PoolKey memory secondaryKey = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 120,
            hooks: IHooks(HOOK_ADDRESS)
        });
        manager.initialize(secondaryKey, SQRT_PRICE_1_1);
        liquidityRouter.modifyLiquidity(
            secondaryKey,
            ModifyLiquidityParams({tickLower: -240, tickUpper: 240, liquidityDelta: 1e18, salt: 0}),
            bytes("")
        );

        // A native/token pool is part of the browser fixture as a conformance
        // target for the real-token lane. It is created after the original two
        // pools so their deployed addresses and identities remain stable.
        PoolKey memory nativeKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token0)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(HOOK_ADDRESS)
        });
        manager.initialize(nativeKey, SQRT_PRICE_1_1);
        liquidityRouter.modifyLiquidity{value: 10 ether}(
            nativeKey,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e18, salt: 0}),
            bytes("")
        );
        vm.stopPrank();

        hook.configureSwapFee(3000);
        hook.configureRouter(address(swapRouter));

        string memory fixture = "hacken-browser-fixture";
        vm.serializeUint(fixture, "chainId", block.chainid);
        vm.serializeAddress(fixture, "actor", ACTOR);
        vm.serializeAddress(fixture, "observer", OBSERVER);
        vm.serializeAddress(fixture, "poolManager", address(manager));
        vm.serializeAddress(fixture, "swapRouter", address(swapRouter));
        vm.serializeAddress(fixture, "alternateSwapRouter", address(alternateSwapRouter));
        vm.serializeAddress(fixture, "liquidityRouter", address(liquidityRouter));
        vm.serializeAddress(fixture, "donateRouter", address(donateRouter));
        vm.serializeAddress(fixture, "hook", HOOK_ADDRESS);
        vm.serializeAddress(fixture, "currency0", address(token0));
        vm.serializeAddress(fixture, "currency1", address(token1));
        vm.serializeUint(fixture, "fee", key.fee);
        vm.serializeInt(fixture, "tickSpacing", key.tickSpacing);
        vm.serializeBytes32(fixture, "poolId", PoolId.unwrap(key.toId()));
        vm.serializeBytes32(fixture, "secondaryPoolId", PoolId.unwrap(secondaryKey.toId()));
        vm.serializeInt(fixture, "secondaryTickSpacing", secondaryKey.tickSpacing);
        vm.serializeAddress(fixture, "nativeCurrency0", Currency.unwrap(nativeKey.currency0));
        vm.serializeAddress(fixture, "nativeCurrency1", Currency.unwrap(nativeKey.currency1));
        vm.serializeBytes32(fixture, "nativePoolId", PoolId.unwrap(nativeKey.toId()));
        string memory json = vm.serializeString(fixture, "sqrtPriceX96", vm.toString(SQRT_PRICE_1_1));
        vm.writeJson(json, "src/fixtures/generated/hacken-context.json");
        vm.dumpState("src/fixtures/generated/hacken-state.json");
    }
}

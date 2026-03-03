# 💼 Beat Powell

Onchain game where you can "hit" Jerome Powell to lower the Fed interest rate!

## 🎮 Game Mechanics

- **Each hit lowers the rate by 0.01%**
- **Powell recovers +0.05% every hour** (he fights back!)
- **1 hour cooldown** between hits per wallet
- **Current Fed Rate**: 3.75%

## 🚀 Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Deploy Smart Contract

Go to your Hardhat project folder and deploy:
```bash
npx hardhat compile
npx hardhat run scripts/deploy.js --network base
```

### 3. Configure Contract + Paymaster

Create `.env.local` in the project root:
```bash
VITE_CONTRACT_ADDRESS=YOUR_DEPLOYED_CONTRACT_ADDRESS
VITE_PAYMASTER_URL=YOUR_PAYMASTER_URL
```

- If `VITE_PAYMASTER_URL` is empty, transactions are sent without sponsorship.
- If it is set and supported by wallet capabilities, gas is sponsored.

### 4. Get Paymaster URL (optional, for gasless transactions)

1. Go to https://portal.cdp.coinbase.com/
2. Create a new project
3. Copy Paymaster URL for Base mainnet
4. Paste it into `.env.local` as `VITE_PAYMASTER_URL`

### 5. Run locally
```bash
npm run dev
```

### 6. Build for production
```bash
npm run build
```

## 📝 Smart Contract

```solidity
// Current rate: 3.75%
// Decrease per press: 0.01%
// Increase per hour: 0.05%
// Cooldown: 1 hour
```

## 🔗 Tech Stack

- React + Vite
- Wagmi v2 + Viem
- Base Account (Smart Wallet)
- Farcaster Mini App support
- Solidity (Hardhat)

## 🎯 Features

- ✅ Base Account integration
- ✅ Gasless transactions (via Paymaster)
- ✅ Real-time rate updates
- ✅ Cooldown timer
- ✅ Rate recovery mechanic
- ✅ Works in Base App / Farcaster

---

**The printer goes BRRR** 🖨️💸


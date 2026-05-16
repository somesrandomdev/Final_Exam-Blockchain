require("@nomicfoundation/hardhat-toolbox");

const sepolia =
  process.env.SEPOLIA_RPC_URL && process.env.SEPOLIA_PRIVATE_KEY
    ? {
        url: process.env.SEPOLIA_RPC_URL,
        accounts: [process.env.SEPOLIA_PRIVATE_KEY]
      }
    : undefined;

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    ...(sepolia ? { sepolia } : {})
  }
};

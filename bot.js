require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');

// Logger function
function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}`;
    console.log(logMessage);

    // Also write to log file
    const logFile = path.join(__dirname, 'bot.log');
    fs.appendFileSync(logFile, logMessage + '\n');
}

// Configuration
const TOKEN_ADDRESS = '0x20d704099B62aDa091028bcFc44445041eD16f09';
const FROM_ADDRESS = '0xdECAF122E4d89afBCeCC341ECFe9987A67cDF93E';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const CACHE_FILE = path.join(__dirname, 'tx_cache.json');
const POLL_INTERVAL = 60 * 1000; // 1 minute in milliseconds
const RETRY_DELAY = 30 * 1000; // 30 seconds

// Initialize cache
let txCache = new Set();
if (fs.existsSync(CACHE_FILE)) {
    txCache = new Set(JSON.parse(fs.readFileSync(CACHE_FILE)));
    log(`Loaded ${txCache.size} transactions from cache`);
}

// Save cache function
function saveCache() {
    fs.writeFileSync(CACHE_FILE, JSON.stringify([...txCache]));
    log(`Cache saved with ${txCache.size} transactions`);
}

// ABI for Transfer event
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

let provider;
let contract;
let lastCheckedBlock = 0;

// Initialize provider with retry logic
async function initializeProvider() {
    try {
        if (!process.env.RPC_ENDPOINT) {
            throw new Error('RPC_ENDPOINT not configured in .env');
        }

        provider = new ethers.providers.JsonRpcProvider(process.env.RPC_ENDPOINT);
        log('Attempting to connect to Ethereum node...');

        // Test the connection
        await provider.getNetwork();
        log('Successfully connected to Ethereum node');

        // Initialize contract
        contract = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider);
        return true;
    } catch (error) {
        log(`Failed to initialize provider: ${error.message}`, 'ERROR');
        return false;
    }
}

// Initialize Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to get transfers with retry logic
async function checkTransfers() {
    try {
        // Check if provider is initialized
        if (!provider || !contract) {
            log('Provider not initialized, attempting to initialize...', 'WARN');
            const success = await initializeProvider();
            if (!success) {
                throw new Error('Failed to initialize provider');
            }
        }

        const currentBlock = await provider.getBlockNumber();

        if (lastCheckedBlock === 0) {
            lastCheckedBlock = currentBlock;
            log(`Initial block set to ${currentBlock}`);
            return;
        }

        log(`Checking blocks from ${lastCheckedBlock + 1} to ${currentBlock}`);

        const events = await contract.queryFilter('Transfer', lastCheckedBlock + 1, currentBlock);
        log(`Found ${events.length} total transfer events`);

        for (const event of events) {
            const from = event.args.from;
            const to = event.args.to;
            const value = event.args.value;
            const txHash = event.transactionHash;

            if (from.toLowerCase() === FROM_ADDRESS.toLowerCase() &&
                to.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {

                log(`Found matching transfer - TX Hash: ${txHash}`);

                if (txCache.has(txHash)) {
                    log(`Transaction ${txHash} already processed - skipping`, 'WARN');
                    continue;
                }

                const receipt = await provider.getTransactionReceipt(txHash);
                const block = await provider.getBlock(receipt.blockNumber);
                const amount = ethers.utils.formatUnits(value, 18);

                log(`Processing burn transaction:
                    Amount: ${amount}
                    Block: ${receipt.blockNumber}
                    Time: ${new Date(block.timestamp * 1000).toUTCString()}`);

                const message = `🔥 Burn Transaction Detected!\n\n` +
                    `Amount: ${amount} tokens\n` +
                    `Transaction: https://basescan.org/tx/${txHash}\n` +
                    `Block: ${receipt.blockNumber}\n` +
                    `Time: ${new Date(block.timestamp * 1000).toUTCString()}`;

                await bot.sendMessage(CHAT_ID, message);
                log(`Telegram notification sent for transaction ${txHash}`);

                txCache.add(txHash);
                saveCache();
                log(`Transaction ${txHash} added to cache`);
            }
        }

        lastCheckedBlock = currentBlock;
        log(`Updated last checked block to ${currentBlock}`);

    } catch (error) {
        log(`Error checking transfers: ${error.message}`, 'ERROR');
        console.error(error);

        // Reset provider on error
        provider = null;
        contract = null;

        // Schedule retry
        log(`Will retry in ${RETRY_DELAY / 1000} seconds...`, 'INFO');
    }
}

// Start bot
async function startBot() {
    log('Bot initialization started');
    log(`Using RPC endpoint: ${process.env.RPC_ENDPOINT}`);
    log(`Monitoring transfers from ${FROM_ADDRESS} to ${DEAD_ADDRESS}`);
    log(`Using token contract: ${TOKEN_ADDRESS}`);
    log(`Poll interval: ${POLL_INTERVAL / 1000} seconds`);

    // Initial setup
    const success = await initializeProvider();
    if (success) {
        // Initial check
        await checkTransfers();

        // Set up polling interval
        setInterval(checkTransfers, POLL_INTERVAL);
        log('Bot is now running and polling for transfers');
    } else {
        log('Initial setup failed, retrying in 30 seconds...', 'WARN');
        setTimeout(startBot, RETRY_DELAY);
    }
}

// Basic error handling for the bot
bot.on('error', (error) => {
    log(`Telegram Bot Error: ${error.message}`, 'ERROR');
    console.error(error);
});

// Handle process termination
process.on('SIGINT', () => {
    log('Received SIGINT signal - shutting down');
    saveCache();
    process.exit();
});

process.on('SIGTERM', () => {
    log('Received SIGTERM signal - shutting down');
    saveCache();
    process.exit();
});

// Start the bot
startBot();
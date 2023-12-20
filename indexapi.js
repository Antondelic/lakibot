require('dotenv').config();
console.log("Environment variables loaded.");

const { Web3 } = require('web3');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const mongoUri = process.env.MONGODB_URI;
const mongoClient = new MongoClient(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
let prizePercentage;

let db;

async function connectMongoDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db(); // If you specified a database in the URI, it connects to it. Otherwise, specify here.
        console.log("Connected to MongoDB");
    } catch (e) {
        console.error("Could not connect to MongoDB", e);
        process.exit(1);
    }
}

connectMongoDB();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Endpoint to get the wallet balance
app.get('/api/wallet-balance', async (req, res) => {
    try {
        const balance = await fetchWalletBalance();
        res.json({ balance });
    } catch (error) {
        res.status(500).send('Error fetching wallet balance');
    }
});

// Endpoint to get the time until the next ball
app.get('/api/time-until-next', (req, res) => {
    const currentTime = new Date();
    const timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();

    if (timeUntilNextBall <= 0) {
        res.json({ minutes: 0, seconds: 0 });
    } else {
        const minutes = Math.floor(timeUntilNextBall / 60000);
        const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);
        res.json({ minutes, seconds });
    }
});

// Endpoint to check the number of balls for a specific address
app.get('/api/check-balls/:address', (req, res) => {
    const address = req.params.address;
    const ballsCount = crystalBallWins[address] || 0;
    res.json({ balls: ballsCount });
});

// Endpoint to get previous winners
app.get('/api/previous-winners', (req, res) => {
    res.json({ winners: winnersHistory });
});

let crystalBallHolders = {};
let crystalBallWins = {};
let nextCrystalBallTime = new Date();
nextCrystalBallTime.setMinutes(nextCrystalBallTime.getMinutes() + 1); // Set to 2 minutes from the current time

async function loadCrystalBallWins() {
    try {
        const collection = db.collection('crystalBallWins');
        const data = await collection.find({}).toArray();

        crystalBallWins = {};
        winnersHistory = [];
        data.forEach(item => {
            crystalBallWins[item.address] = item.wins;
            if (item.percentage) {
                winnersHistory.push({ winner: item.address, percentage: item.percentage });
            }
        });

        filterBlacklistedAddresses();
        console.log("Crystal ball wins loaded from MongoDB.");
    } catch (error) {
        console.error('Error loading crystal ball wins from MongoDB:', error);
    }
}


function shortenAddress(address) {
    return `${address.substring(0, 5)}...${address.substring(address.length - 3)}`;
}

function getRankEmoji(index) {
    switch (index) {
        case 0: return '🥇';
        case 1: return '🥈';
        case 2: return '🥉';
        default: return `  ${index + 1}.`;
    }
}

function filterBlacklistedAddresses() {
    const blacklistedAddressesArray = process.env.BLACKLISTED_ADDRESSES.split(',');
    blacklistedAddressesArray.forEach(address => {
        if (crystalBallWins[address.trim()]) {
            delete crystalBallWins[address.trim()];
        }
    });
    console.log("Blacklisted addresses filtered.");
}


console.log("Modules imported.");

if (!process.env.INFURA_URL) {
    console.error("INFURA_URL is not set in .env file.");
    process.exit(1);
}

const web3 = new Web3(process.env.INFURA_URL);
console.log("Web3 initialized.");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
console.log("Telegram bot initialized.");

async function saveCrystalBallWins() {
    try {
        const collection = db.collection('crystalBallWins');
        await collection.deleteMany({}); // Clear existing data

        const data = Object.entries(crystalBallWins).map(([address, wins]) => {
            const percentage = winnersHistory.find(winner => winner.winner === address)?.percentage || '';
            return { address, wins, percentage };
        });

        await collection.insertMany(data);
        console.log("Crystal ball wins saved to MongoDB.");
    } catch (error) {
        console.error('Error saving crystal ball wins to MongoDB:', error);
    }
}



function updateNextCrystalBallTime() {
    nextCrystalBallTime = new Date();
    nextCrystalBallTime.setMinutes(nextCrystalBallTime.getMinutes() + 1);
}

async function fetchTokenHolders() {
    try {
        console.log("Fetching token holders for crystal ball distribution...");

        const chainId = '56';
        const contractAddress = '0xa1164E3ee1396CC507872842F3BB44B393755df3';
        const covalentApiKey = process.env.COVALENT_API_KEY;
        const url = `https://api.covalenthq.com/v1/${chainId}/tokens/${contractAddress}/token_holders/?key=${covalentApiKey}`;

        console.log("Covalent API URL:", url);

        const response = await axios.get(url);
        const data = response.data;

        if (!data || !data.data || !data.data.items) {
            throw new Error('Invalid data format received from Covalent API');
        }

        const blacklistedAddresses = process.env.BLACKLISTED_ADDRESSES.split(',');

        const holders = data.data.items
            .filter(holder => !blacklistedAddresses.includes(holder.address.toLowerCase()))
            .map(holder => ({
                address: holder.address,
                balance: parseFloat(holder.balance) / Math.pow(10, holder.contract_decimals)
            }));

        console.log(`Fetched ${holders.length} token holders.`);
        console.log("First 5 token holders:", holders.slice(0, 5));

        return holders;

    } catch (error) {
        console.error('Error fetching token holders:', error);
        return [];
    }
}

async function fetchWalletBalance() {
    try {
        // Log the address for debugging
        console.log(`Fetching balance for address: ${process.env.SENDER_ADDRESS}`);

        // Check if the address is defined
        if (!process.env.SENDER_ADDRESS) {
            throw new Error('SENDER_ADDRESS is not defined in the environment variables.');
        }

        const balanceWei = await web3.eth.getBalance(process.env.SENDER_ADDRESS);
        return web3.utils.fromWei(balanceWei, 'ether');

    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        console.error('Error fetching token holders:', error);
        return 'Error fetching balance';
    }
}

function calculateTickets(holders) {
    console.log("Calculating tickets for holders:", holders);

    const tickets = {};
    for (const holder of holders) {
        if (holder.balance <= 0) {
            console.log(`Balance for ${holder.address} is zero or negative, skipping.`);
            continue;
        }
        // Assign one ticket per token.
        tickets[holder.address] = holder.balance;
        console.log(`Address: ${holder.address}, Tickets: ${holder.balance}`);
    }
    return tickets;
}


function selectWinner(tickets) {
    // Calculate the total sum of all tickets
    const totalTickets = Object.values(tickets).reduce((acc, count) => acc + count, 0);

    if (totalTickets === 0) {
        console.error("No valid tickets for selecting a winner.");
        return null;
    }

    // Generate a random position on this scale
    let randomPosition = Math.random() * totalTickets;

    for (const [address, count] of Object.entries(tickets)) {
        // Subtract the count from the random position
        randomPosition -= count;
        if (randomPosition <= 0) {
            // This is the winning address
            return address;
        }
    }
}


// Function to send an announcement message
async function sendAnnouncement(winner, ballsCount, prizePercentage, txId = null) {
    let message, imageUrl;
    const shortenedWinner = shortenAddress(winner);
    switch (ballsCount) {
        case 1:
            imageUrl = "https://i.ibb.co/zJ22FG8/DALL-E-2023-12-05-16-50-19-A-single-pink-crystal-ball-inspired-by-Lucky-Lady-s-charm-casino-game-wit.png"; // Replace with your actual URL
            message = `Congratulations ${shortenedWinner}!\nYou are now holding 1 crystal ball!`;
            break;
        case 2:
            imageUrl = "https://i.ibb.co/0tqJQgg/DALL-E-2023-12-05-16-50-16-Two-pink-crystal-balls-inspired-by-Lucky-Lady-s-charm-casino-game-with-a.png"; // Replace with your actual URL
            message = `Congratulations ${shortenedWinner}!\nYou are now holding 2 crystal balls!`;
            break;
        case 3:
            imageUrl = "https://i.ibb.co/X51N3PN/DALL-E-2023-12-05-16-50-13-Three-pink-crystal-balls-inspired-by-Lucky-Lady-s-charm-casino-game-arran.png";
            if (txId) {
                message = `🎉 Congratulations to ${shortenedWinner}! You've won ${prizePercentage.toFixed(2)}% of the prize! 🎉\nTransaction ID: ${txId}`;
            } else {
                message = `There was an issue with the transaction for ${shortenedWinner}. Please contact support.`;
            }
            // Set the appropriate image URL for case 3
            break;
        default:
            console.error("Invalid number of crystal balls for announcement.");
            return;
    }
    await bot.sendPhoto(process.env.ANNOUNCEMENT_CHAT_ID, imageUrl, { caption: message });
}

let initialDistributionCount = 0;
const INITIAL_DISTRIBUTION_LIMIT = 50;

async function distributeCrystalBall() {
    try {
        console.log("Distributing crystal ball...");

        const holders = await fetchTokenHolders();
        if (holders.length === 0) {
            console.log("No token holders found, skipping crystal ball distribution.");
            return;
        }

        console.log(`Found ${holders.length} token holders. Calculating tickets...`);
        const tickets = calculateTickets(holders);
        if (Object.keys(tickets).length === 0) {
            console.log("No valid tickets calculated, aborting distribution.");
            return;
        }

        console.log("Selecting a winner...");
        const winner = selectWinner(tickets);
        if (!winner) {
            console.log("No winner selected, aborting distribution.");
            return;
        }

        console.log(`Selected winner: ${winner}`);
        crystalBallWins[winner] = (crystalBallWins[winner] || 0) + 1;

        if (crystalBallWins[winner] === 3) {
            console.log(`Distributing prize to ${winner} who has collected 3 crystal balls.`);
            crystalBallWins[winner] = 0;
            prizePercentage = Math.random() * (100 - 25) + 25;

            try {
                console.log("Initiating prize transaction...");
                const txHash = await sendTransaction(winner, prizePercentage / 100);
                if (txHash) {
                    console.log(`Prize transaction successful with hash: ${txHash}`);
                    await sendAnnouncement(winner, 3, prizePercentage, txHash);
                } else {
                    console.log('Prize transaction failed or was not sent.');
                    await sendAnnouncement(winner, 3, prizePercentage, null);
                }
                winnersHistory.push({ winner: winner, percentage: parseFloat(prizePercentage.toFixed(2)) });
            } catch (error) {
                console.error(`Error during prize transaction: ${error}`);
            }
        } else {
            console.log(`Announcing distribution for ${crystalBallWins[winner]} crystal ball(s) to ${winner}...`);
            await sendAnnouncement(winner, crystalBallWins[winner], prizePercentage);
        }

        updateNextCrystalBallTime();
        await saveCrystalBallWins();
    } catch (error) {
        console.error(`Error in distributeCrystalBall: ${error}`);
    }
}

async function sendTransaction(winner, prizePercentage) {
    try {
        const winnerChecksummed = web3.utils.toChecksumAddress(winner);
        console.log(`Sending transaction to winner: ${winnerChecksummed}`);

        const balance = BigInt(await web3.eth.getBalance(process.env.SENDER_ADDRESS));
        console.log(`Balance: ${balance}`);

        if (balance === BigInt(0)) {
            const announcementMessage = 'Announcement: Insufficient funds for prize distribution. Balance is zero!';
            console.log(announcementMessage);

            // Send message to the specified chat
            await bot.sendMessage(process.env.ANNOUNCEMENT_CHAT_ID, announcementMessage, { parse_mode: 'Markdown' });

            return null;
        }

        const estimatedGas = BigInt(21000);
        const gasPrice = BigInt(await web3.eth.getGasPrice());
        console.log(`Gas Estimate: ${estimatedGas}, Gas Price: ${gasPrice}`);

        const prizePercentageValue = Number(prizePercentage);
        console.log(`Prize Percentage: ${prizePercentageValue}`);

        const prizeAmount = BigInt(Math.round(prizePercentageValue * Number(balance)));
        console.log(`Prize Amount: ${prizeAmount}`);

        const gasCost = BigInt(estimatedGas * gasPrice);
        console.log(`Gas Cost: ${gasCost}`);

        const valueToSend = prizeAmount - gasCost;  // No need to convert to BigInt here
        console.log(`Calculated value to send: ${valueToSend}`);

        if (valueToSend <= BigInt(0)) {
            console.log(`Insufficient balance to send transaction to ${winnerChecksummed}.`);
            return null;
        }

        const transaction = {
            to: winnerChecksummed,
            value: valueToSend.toString(),
            gas: estimatedGas,
            gasPrice: gasPrice,
            nonce: BigInt(await web3.eth.getTransactionCount(process.env.SENDER_ADDRESS)),
            chainId: 56
        };

        console.log('Sending transaction:', transaction);

        const signedTransaction = await web3.eth.accounts.signTransaction(transaction, process.env.PRIVATE_KEY);
        console.log('Transaction signed.');

        const receipt = await web3.eth.sendSignedTransaction(signedTransaction.rawTransaction);
        console.log('Transaction sent successfully:', receipt);

        return receipt.transactionHash;
    } catch (error) {
        console.error(`Error sending transaction: ${error}`);
        console.error(error.reason); // Check if there's a reason for the revert
        return null;
    }
}


bot.onText(/\/wen/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const currentTime = new Date();
        let timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();

        if (timeUntilNextBall <= 0) {
            // This means the distribution should be happening now
            await bot.sendMessage(chatId, "The next crystal ball distribution is happening now!");
            return;
        }

        // Convert milliseconds to minutes and seconds
        const minutes = Math.floor(timeUntilNextBall / 60000);
        const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);

        const reply = `Time until next ball is ${minutes} minutes and ${seconds} seconds.`;
        await bot.sendMessage(chatId, reply);

        console.log("Replied to /time command.");
    } catch (error) {
        console.error(`Error in /time command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});


bot.onText(/\/balls/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        let sortedBallWins = Object.entries(crystalBallWins).sort((a, b) => b[1] - a[1]);
        let reply = '🔮 Top 15 Crystal Ball Counts 🔮\n\n';
        sortedBallWins.slice(0, 15).forEach(([address, count], index) => {
            let ballIcons = count > 0 ? '🔮'.repeat(count) : '';
            reply += `${getRankEmoji(index)} ${shortenAddress(address)} - ${ballIcons}\n`;
        });

        await bot.sendMessage(chatId, reply);
        console.log("Replied to /balls command.");
    } catch (error) {
        console.error(`Error in /balls command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});








bot.onText(/\/prize/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const balance = await fetchWalletBalance();
        const reply = `Current wallet holding: ${balance} BNB`;
        await bot.sendMessage(chatId, reply);
        console.log("Replied to /prize command.");
    } catch (error) {
        console.error(`Error in /prize command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});

bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        let sortedWinners = [...winnersHistory].sort((a, b) => b.percentage - a.percentage);
        let reply = '🏆 Top 15 Winners 🏆\n\n';
        sortedWinners.slice(0, 15).forEach((record, index) => {
            const roundedPercentage = parseFloat(record.percentage).toFixed(2);  // Round the percentage
            reply += `${getRankEmoji(index)} ${shortenAddress(record.winner)} - ${roundedPercentage}%\n`;
        });

        if (sortedWinners.length === 0) {
            reply = "No winners recorded yet.";
        }

        await bot.sendMessage(chatId, reply);
        console.log("Replied to /winners command.");
    } catch (error) {
        console.error(`Error in /winners command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});





bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
        const address = match[1];
        const count = crystalBallWins[address] || 0;
        const reply = `${address} has ${count} crystal ball(s) 🔮`;
        await bot.sendMessage(chatId, reply);
        console.log("Replied to /check command.");
    } catch (error) {
        console.error(`Error in /check command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const image_url = 'https://i.ibb.co/RTLR4qp/DALL-E-2023-12-05-18-52-09-An-artwork-for-a-help-handler-in-a-Telegram-group-styled-similarly-to-the.png';
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Balls', callback_data: 'top_10_balls' },
                        { text: 'Wen', callback_data: 'time_until_next' },
                    ],
                    [
                        { text: 'Prize', callback_data: 'wallet_balance' },
                        { text: 'Wins', callback_data: 'top_10_winners' },
                    ],
                ],
            },
        };

        // Send a new message with the photo and inline keyboard
        await bot.sendPhoto(chatId, image_url, { caption: '', reply_markup: options.reply_markup });
        console.log("Replied to /help command with photo.");
    } catch (error) {
        console.error(`Error in /help command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});

// Define a callback handler for the inline keyboard buttons
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;

    try {
        if (query.data === 'top_10_balls') {
            // Handle the "Balls - Top 10 Crystal Ball Holders" button click
            const sortedHolders = Object.entries(crystalBallWins).sort((a, b) => b[1] - a[1]).slice(0, 10);
            let reply = "🔝 TOP 10 🔝\n";
            for (let i = 0; i < sortedHolders.length; i++) {
                const [address, count] = sortedHolders[i];
                const crystalBallEmojis = '🔮'.repeat(count);
                reply += `${i + 1}. ${shortenAddress(address)}: ${crystalBallEmojis}\n`;
            }

            await bot.sendMessage(chatId, reply);
        } else if (query.data === 'time_until_next') {
            // Handle the "Time Until Next Ball" button click
            const currentTime = new Date();
            const timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();
            const minutes = Math.floor(timeUntilNextBall / 60000);
            const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);
            const callbackAnswer = `Time until next ball is ${minutes} minutes and ${seconds} seconds.`;
            await bot.answerCallbackQuery(query.id, { text: callbackAnswer });
        } else if (query.data === 'wallet_balance') {
            // Handle the "Prize - Wallet Balance" button click
            const balance = await fetchWalletBalance();
            const callbackAnswer = `Current wallet holding: ${balance} BNB`;
            await bot.answerCallbackQuery(query.id, { text: callbackAnswer });
        } else if (query.data === 'top_10_winners') {
            // Handle the "Wins - Top 10 Winners" button click
            let sortedWinners = [...winnersHistory].sort((a, b) => b.percentage - a.percentage);
            let reply = '🏆 TOP 10 Winners 🏆\n\n';
        
            for (let i = 0; i < sortedWinners.length && i < 10; i++) {
                const record = sortedWinners[i];
                const roundedPercentage = parseFloat(record.percentage).toFixed(2);  // Round the percentage
                reply += `${getRankEmoji(i)} ${shortenAddress(record.winner)} - ${roundedPercentage}%\n`;
            }

            if (sortedWinners.length === 0) {
                reply = "No winners recorded yet.";
            }

            await bot.sendMessage(chatId, reply);
        }
    } catch (error) {
        console.error(`Error in handling callback query: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});





async function main() {
    console.log("Starting main function.");

    // Connect to MongoDB and load data
    await connectMongoDB();
    await loadCrystalBallWins();

    // Schedule the crystal ball distribution task
    cron.schedule('*/1 * * * *', () => {
        console.log("Scheduled crystal ball distribution task triggered.");

        // Update next distribution time immediately
        updateNextCrystalBallTime();

        distributeCrystalBall();
    });

    // Start the Telegram bot polling
    if (!bot.isPolling()) {
        console.log("Starting bot polling...");
        bot.startPolling();
        console.log("Bot polling started.");
    } else {
        console.log("Bot is already polling. No need to start again.");
    }
}

main().catch(error => {
    console.error('Error in main function:', error);
});

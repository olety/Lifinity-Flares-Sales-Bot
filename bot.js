const tw = require('twitter-api-v2');
const yaml = require('js-yaml');
const fs = require('fs');
const hs = require('hyperspace-client-js');
const sharp = require('sharp');

// Function for fetching the image buffer from a URL
async function downloadImage(url) {
    const response = await fetch(url);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer;
}

// From https://stackoverflow.com/questions/13627308/add-st-nd-rd-and-th-ordinal-suffix-to-a-number
function getNumberWithOrdinal(n) {
    var s = ["th", "st", "nd", "rd"],
        v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Twitter doesn't support webp animations so we need to convert it to GIF
// Also, twitter GIF resolution is 1x1
async function webpToGif(webpBuffer, animated = true, width = 700, height = 700, dither = 0) {
    return sharp(webpBuffer, { animated: animated })
        .resize({ width: width, height: height })
        .gif({ effort: 1, dither: dither })
        .toBuffer();
}

async function postImageText(imageUrl, tweetText) {
    // First, download the Webp image and convert it to GIF
    // Since Twitter gif and video ratio is 1:1, we need to crop it too (done in webpToGif)
    try {
        imgWebp = await downloadImage(imageUrl);
    } catch (error) {
        console.error("postImageText: error when getting the liflare image");
        console.error(error);
        throw error;
    }

    try {
        imgGIF = await webpToGif(imgWebp)
    } catch (error) {
        console.error("postImageText: error when converting to GIF");
        console.error(error);
        throw error;
    }

    // Second, upload the image to Twitter and get the ID
    try {
        var mediaId = await client.v1.uploadMedia(imgGIF, { mimeType: tw.EUploadMimeType.Gif });
        console.log(`Successfully uploaded media, ID ${mediaId}`);
    } catch (error) {
        console.error("postImageText: error when uploading image to twitter");
        console.error(error);
        throw error;
    }

    // Third, tweet and attach the image to the tweet
    try {
        response = await client.v1.tweet(tweetText, { media_ids: mediaId });
    } catch (error) {
        console.error("postImageText: error when tweeting after uploading image");
        console.error(error);
        throw error;
    }
    return response
}

async function postText(tweetText) {
    response = await client.v1.tweet(tweetText);
    return response
}

// Function to tweet the given data
async function tweetData(tx) {
    if (!tx) {
        return;
    }
    // Tweet template
    const solscanUrl = `https://solscan.io/tx/${tx.txId}`;
    const floorPrice = await getFloorPrice(settings.app.projectId);
    const tweetTemplate =
        (tx.buyerTwitter ? `@${tx.buyerTwitter}` : "Someone") + ` just purchased Lifinity Flare #${tx.nftId} \n` 
        +(tx.sellerTwitter ? `from @${tx.sellerTwitter} ` : "") + (tx.mp ? `on ${tx.mp.name} ` : "on Solana ") + `for ◎${tx.nftPrice}!` + (floorPrice ? ` (floor ◎${floorPrice})` : "") + "\n\n" 
        + `Transaction details 👉 ${solscanUrl} \n`
        + "\n#NFTs #Solana #Lifinity #LifinityFlares";

    try {
        return await postImageText(tx.imgUrl, tweetTemplate);
    } catch (imgError) {
        console.error("Couldn't post the image+text tweet")
        console.log("Trying text-only post...")
        try {
            return await postText(tweetTemplate);
        } catch (textError) {
            console.error("Couldn't post the text tweet")
            console.error(textError);
        }
    }
    return;
}

async function getLastTweetTxId(twitterId) {
    var txId;
    try {
        result = await client.v1.userTimelineByUsername(twitterId);
        txId = result._realData[0].entities.urls[0].expanded_url.split("/tx/")[1];
    } catch (error) {
        console.error("getLastTweetTxId: problem when getting the tx ID")
        console.error(error);
    }
    return txId;
}

// Get a Hyperspace transaction query object for the given projectId
function getHsTxQueryObject(projectId, { pageNumber = 1, pageSize = 50 } = {}) {
    return {
        condition: {
            projects: [{ project_id: projectId }],
            actionTypes: ["TRANSACTION"]
        },
        paginationInfo: {
            page_number: pageNumber,
            page_size: pageSize
        }
    }
}

// Get a Hyperspace project query object for the given projectId
function getHsProjQueryObject(projectId) {
    return {
        condition: {
            matchName: {
                operation: "EXACT",
                value: projectId
            }
        }
    }
}

// Process an array of transactions until it finds stopTxId or stopTimestamp
// Returns an object {txList: <Array>, needMorePages: <Boolean>}
function processTxList(txArr, stopTxId, stopTimestamp, priceDecimalPlaces=2) {
    var txArrUpd = []
    var needMorePages = true;
    for (const tx of txArr) {
        txId = tx["market_place_state"]["signature"];
        txTimestamp = tx["market_place_state"]["block_timestamp"];

        if (txId == stopTxId || parseInt(txTimestamp) < stopTimestamp) {
            needMorePages = false;
            break;
        } else {
            txArrUpd.push({
                "nftId": tx["name"].split("#")[1],
                "imgUrl": tx["full_img"],
                "txId": txId,
                "buyerTwitter": tx["market_place_state"]["metadata"]["buyer_twitter"],
                "sellerTwitter": tx["market_place_state"]["metadata"]["seller_twitter"],
                "nftPrice": tx["market_place_state"]["price"].toFixed(priceDecimalPlaces),
                "timestamp": txTimestamp,
                "mp": getMarketplaceById(tx["market_place_state"]["marketplace_program_id"], tx["market_place_state"]["marketplace_instance_id"])
            })
        }
    }
    return { txArr: txArrUpd, needMorePages: needMorePages };
}

// Function to query the Hyperspace API and return the data
// Can get transactions up to a certain timestamp or up to a certain txId
// When provided both, stops at whichever one comes up first 
// By default, gets all sales for the project (collection)
// Timestamp should be in seconds
async function getSales(projectId, { stopTxId = "-1", stopTimestamp = -1, maxPagesToGet = 3  } = {}) {
    var txArr = []
    var currentPage = 1;
    while (true) {
        try {
            page = await hsClient.getProjectHistory(getHsTxQueryObject(projectId, { pageNumber: currentPage }));
        } catch (error) {
            console.error(`getSales: Failed to fetch sales history for ${projectId}.\nstopTxId: ${stopTxId}\nstopTimestamp: ${stopTimestamp}\nMax pages to get: ${maxPagesToGet}\nCurrent page:${currentPage}`)
            console.error(error);
            throw error;
        }
        processResult = processTxList(page["getProjectHistory"]["market_place_snapshots"], stopTxId, stopTimestamp);
        txArr.push(...processResult.txArr);
        if (!processResult.needMorePages || currentPage == maxPagesToGet) {
            break;
        }
        currentPage++;
    }
    return txArr;
}

async function getFloorPrice(projectId, decimalPlaces = 2) {
    var fp;
    try {
        page = await hsClient.searchProjectByName(getHsProjQueryObject(projectId));
        fp = page.getProjectStatByName.project_stats[0].floor_price.toFixed(decimalPlaces);
    } catch (error) {
        console.error(`getFloorPrice: error while finding project stats for "${projectId}"`);
        console.error(error);
    }
    return fp;
}

// Generate the marketplaces.yaml, might want to run this every once in a while to update
async function generateMarketplaceYaml(filename = "marketplaces.yaml") {
    res = await hsClient.getMarketplaceStatus();
    marketplaceArr = res.getMarketPlaceStatus.mps.map(mp => {
        return {
            name: mp.display_name,
            programId: mp.marketplace_program_id,
            instanceId: mp.marketplace_instance_id,
            site: mp.website
        }
    });
    const yamlString = yaml.dump(marketplaceArr);
    fs.writeFileSync(filename, yamlString);
    return marketplaceArr;
}

function getMarketplaceById(programId, instanceId = "") {
    programIdMatch = marketplaces.filter(mp => mp.programId === programId);
    if (programIdMatch.length <= 1) {
        return programIdMatch[0];
    }

    instanceIdMatch = programIdMatch.find(mp => mp.instanceId === instanceId);
    return instanceIdMatch;
}

async function runBot() {
    console.log("Starting a new fetch iteration...");
    lastTweetTxId = await getLastTweetTxId(settings.app.twitterId);
    console.log("Last tweet tx id:");
    console.log(lastTweetTxId);

    txArrToTweet = await (await getSales(settings.app.projectId, {stopTxId: lastTweetTxId, stopTimestamp:settings.app.fetchLimitSeconds})).reverse();
    console.log("Transaction array to tweet out:");
    console.log(txArrToTweet);
    for (const tx of txArrToTweet) {
        const res = await tweetData(tx);
        console.log("Tweeted: ");
        console.log(res);
    }
}

function main() {
    runBot().then(x => {
        console.log("Finished fetch/tweet iteration...")
        console.log(`Waiting for ${settings.app.fetchEverySeconds} seconds...`)
        setTimeout(main, settings.app.fetchEverySeconds*1000)
    });
}

// Initialize Twitter and Hyperspace APIs
// settings.yaml contains Twitter and Hyperspace API keys and app settings
const settings = yaml.load(fs.readFileSync('settings.yaml', 'utf8'));
// Initialize the Twitter client
const client = new tw.TwitterApi({
    appKey: settings.api.twitter.consumerKey,
    appSecret: settings.api.twitter.consumerSecret,
    accessToken: settings.api.twitter.accessTokenKey,
    accessSecret: settings.api.twitter.accessTokenSecret
});
// Initialize the Hyperspace client
const hsClient = new hs.HyperspaceClient(settings.api.hyperspace.apiKey);

// Regenerage the marketplaces yaml file
// marketplaces.yaml contains different NFT marketplace information
generateMarketplaceYaml();
const marketplaces = yaml.load(fs.readFileSync('marketplaces.yaml', 'utf8'));

main();
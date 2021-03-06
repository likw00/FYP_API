'use strict';
const https = require('https');

const GoogleTranslator = require('./lib/GoogleTranslator');
const ImageProcessor = require('./lib/ImageProcessor');
const StorageController = require("./lib/StorageController");
const LexController = require("./lib/LexController");
const SimpleTableController = require("./lib/SimpleTableController");
const SessionTracker = require("./lib/SessionTracker");

const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const QRCODE_FUNCTION = process.env.QRCODE_FUNCTION;
const BOT_ALIAS = process.env.BOT_ALIAS;
const BOT_NAME = process.env.BOT_NAME;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const IMAGE_BUCKET = process.env.IMAGE_BUCKET;
const SESSION_TABLE_NAME = process.env.SESSION_TABLE_NAME;
const IMAGE_TABLE = process.env.IMAGE_TABLE;
const ALLOWED_LANGUAGES = process.env.ALLOWED_LANGUAGES;

exports.handler = (event, context, callback) => {
    console.log(JSON.stringify(event));

    if (event.queryStringParameters) {
        console.log("Handle Verification.");
        // process GET request
        let queryParams = event.queryStringParameters;
        let rVerifyToken = queryParams['hub.verify_token'];

        if (rVerifyToken === VERIFY_TOKEN) {
            let challenge = queryParams['hub.challenge'];
            callback(null, createResponse(200, parseInt(challenge)))
        } else {
            callback(null, createResponse(500, 'Error, wrong validation token'));
        }
    } else {
        console.log("Handle Facebook Chat.");
        // process POST request
        let body = JSON.parse(event.body);
        console.log(JSON.stringify(body));

        //Flat Map
        let messagingEvents = body.entry.reduce((list, x) => list.concat(x.messaging), []);

        Promise.all(messagingEvents.map(processMessage))
            .then(values => {
                console.log("Call back without Error");
                console.log(JSON.stringify(values));
                callback(null, createResponse(200, JSON.stringify(values)));
            }).catch(reason => {
            console.log(reason);
            console.log("Call back with Error");
            callback(null, createResponse(200, reason));
        });
    }
};


const processMessage = messagingEvent => new Promise((resolve, reject) => {
    console.log(JSON.stringify(messagingEvent));
    let googleTranslator = new GoogleTranslator(GOOGLE_API_KEY, ALLOWED_LANGUAGES);
    let lexController = new LexController(BOT_NAME, BOT_ALIAS);
    let sessionTracker = new SessionTracker(SESSION_TABLE_NAME);

    let process;
    if (messagingEvent.message.attachments) {   //Facebook Attachments
        let imageLinks = messagingEvent.message.attachments
        //.filter(c => c.type === "image")
            .map(c => c.payload.url);

        console.log("Receive links: " + imageLinks);
        process = Promise.all(imageLinks.map(processImage))
            .then(imageData => new Promise((resolve, reject) => {
                    messagingEvent.imageData = imageData;
                    resolve(messagingEvent);
                }
            )).then(c => sessionTracker.restoreLastSession(c))
            .then(saveImageDataToSessionTable);
    } else {
        if (messagingEvent.message && messagingEvent.message.text) {
            let text = messagingEvent.message.text;
            console.log("Receive a message: " + text);
            process = googleTranslator.detectLanguage(messagingEvent)
                .then(c => sessionTracker.restoreLastSession(c))
                .then(c => googleTranslator.translateRequest(c));
        }
    }
    if (process) {
        process.then(c => lexController.postText(c))
            .then(c => sessionTracker.saveCurrentSession(c))
            .then(c => googleTranslator.translateReply(c))
            .then(messagingEvent => sendTextMessage(messagingEvent.sender.id, messagingEvent.message.reply))
            .then(resolve)
            .catch(reject);
    }
});

const saveImageDataToSessionTable = (messagingEvent) => {
    return new Promise((resolve, reject) => {
        //Save into Session and send send "OK" to Lex.
        let sessionAttributes = messagingEvent.sessionAttributes ? messagingEvent.sessionAttributes : {};
        //Lex sessionAttributes does not support tree like json!
        sessionAttributes.imageData = "true";
        messagingEvent.sessionAttributes = sessionAttributes;

        let imageTable = new SimpleTableController(IMAGE_TABLE);
        imageTable.put({id: messagingEvent.sender.id, data: messagingEvent.imageData})
            .then(data => {
                messagingEvent.message = {text: "OK", language: "en"};
                resolve(messagingEvent);
            }).catch(reject);
    });
};

const processImage = imageLink => {
    console.log("processImage:" + imageLink);
    let imageProcessor = new ImageProcessor(QRCODE_FUNCTION, IMAGE_BUCKET);
    let storageController = new StorageController(IMAGE_BUCKET);
    return storageController.downloadImage(imageLink)
        .then(c => storageController.uploadToS3(c))
        .then(c => imageProcessor.qrCodeDecode(c))
        .then(c => imageProcessor.detectLabels(c));
};

const createResponse = (statusCode, body) => {
    return {
        statusCode: statusCode,
        body: body
    }
};

const sendTextMessage = (senderFbId, text) => new Promise((resolve, reject) => {
    let json = {
        recipient: {id: senderFbId},
        message: {text: text},
    };
    let body = JSON.stringify(json);
    let path = '/v2.6/me/messages?access_token=' + PAGE_TOKEN;
    let options = {
        host: "graph.facebook.com",
        path: path,
        method: 'POST',
        headers: {'Content-Type': 'application/json'}
    };
    let callback = response => {
        let str = '';
        response.on('data', chunk => {
            str += chunk;
        });
        response.on('end', () => {
            resolve(`Sent message ${senderFbId}: \n${text}`);
        });
    };
    let req = https.request(options, callback);
    req.on('error', e => {
        console.log('problem with request: ' + e);
        reject(e)
    });
    req.write(body);
    req.end();
});
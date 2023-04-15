const axios = require("axios");
const bodyParser = require("body-parser");

const express = require("express");

//const https = require("https");
//const fs = require("fs");
//const path = require("path");

const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");

//REST API 서버 생성
const app = express();

//포트 지정
const port = process.env.PORT || 3000;

/*
const sslOptions = {
  key: fs.readFileSync(path.resolve("./ssl/ssl.key")),
  cert: fs.readFileSync(path.resolve("./ssl/ssl.crt")),
};
*/

//JSON 설정
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

//const server = https.createServer(sslOptions, app);

//application info
const CLIENT_ID =
  "9447466321-9mm8v9p1ohln9dqjoeql8p7q6iemjvo0.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "https://togglecampus.org/version-test/google_email_test";

//get oauth2client
async function getOAuth2Client(refreshToken) {
  const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  oAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oAuth2Client;
}

async function getRemoveDuplicatesMessagesId(gmail, historyId) {
  const res = await gmail.users.history.list({
    userId: "me",
    startHistoryId: historyId,
  });

  const do_this_func = res.data.history ? 1 : 0;

  const messageIds = [];

  if (do_this_func == 1) {
    for (const item of res.data.history) {
      if (!item.messagesDeleted) {
        for (const message of item.messages) {
          messageIds.push(message.id);
        }
      }
    }

    return Array.from(new Set(messageIds));
  }
}

async function getMessage(auth, messageId) {
  const gmail = google.gmail({ version: "v1", auth: auth });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
  });
  return res.data;
}

async function handleGmailNotification(user, emailMessage, res) {
  try {
    // Extract the necessary information from the email message
    const emailSubject = emailMessage.payload.headers.find(
      (header) => header.name === "Subject"
    ).value;
    const emailFrom = emailMessage.payload.headers.find(
      (header) => header.name === "From"
    ).value;

    console.log(
      `Received new email from ${emailFrom} to "${user.name}" <${user.authentication.email.email}>: ${emailSubject}`
    );

    try {
      // Replace the URL with your Bubble app's API endpoint URL
      const bubbleApiUrl =
        "https://togglecampus.org/version-test/api/1.1/wf/receive_email_info";

      // Replace 'your_bubble_api_key' with your Bubble app's API key
      const bubbleApiKey = "8a440d780583413427646e1ac0cc374c";

      // Send a POST request to the Bubble API endpoint with the extracted email information
      await axios.post(
        bubbleApiUrl,
        {
          subject: emailSubject,
          from: emailFrom,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bubbleApiKey}`,
          },
        }
      );

      console.log("Email information sent to Bubble app");
    } catch (error) {
      console.error(
        "Error while sending email information to Bubble app:",
        error
      );
    }
  } catch (error) {
    console.error("Error while fetching email message:", error);
    res.sendStatus(500);
  }
}

async function setMailAlarm(user) {
  const gmail_refresh_token = user.gmail_refresh_token;

  const oAuth2Client = await getOAuth2Client(gmail_refresh_token);

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  const request = {
    labelIds: ["INBOX"],
    topicName: "projects/bubble-gmail-383603/topics/GmailAPIPush",
    userId: "me",
  };
  gmail.users.watch(request, (err) => {
    if (err) {
      console.log(err);
      return;
    }
    console.log(`Successfully set gmail alarm for ${user.name}`);
  });
}

async function run() {
  const users = await axios.get(
    "https://togglecampus.org/version-test/api/1.1/obj/user"
  );

  users.data.response.results.forEach((user) => {
    if (user.gmail_refresh_token) {
      setMailAlarm(user);
    }
  });

  console.log(`Start setting gmail alarm for all users`);

  setTimeout(() => {
    run();
  }, 604800000); //일주일 마다 전체 유저를 체크하여 알람 설정을 켜줌. 일주일은 구글의 권장사항임.
}

run();

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/api/users/initialGmailAlarmSet", async (req, res) => {
  const oAuth2Client = await getOAuth2Client(req.body.refreshToken);

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  const request = {
    labelIds: ["INBOX"],
    topicName: "projects/bubble-gmail-383603/topics/GmailAPIPush",
    userId: "me",
  };
  gmail.users.watch(request, (err) => {
    if (err) {
      console.log(err);
      res.status(500).send(err);
      return;
    }
    res.status(200).send("OK");
    console.log(`Successfully set gmail alarm for ${req.body.userName}`);
  });
});

// 구글 sub를 위한 웹훅 라우터
app.post("/api/gmailAPIWebhook", async (req, res) => {
  //req 데이터를 디코딩하고 "req_message_data_decoded"에 저장
  const base64EncodedString = req.body.message.data;
  const buffer = Buffer.from(base64EncodedString, "base64");
  const decodedString = buffer.toString("utf-8");

  const req_message_data_decoded = JSON.parse(decodedString);

  const users = await axios.get(
    "https://togglecampus.org/version-test/api/1.1/obj/user"
  );

  users.data.response.results.forEach(async (user) => {
    if (
      user.authentication.email.email === req_message_data_decoded.emailAddress
    ) {
      const gmail_refresh_token = user.gmail_refresh_token;
      const oAuth2Client = await getOAuth2Client(gmail_refresh_token);
      const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

      const messagesIds = await getRemoveDuplicatesMessagesId(
        gmail,
        req_message_data_decoded.historyId
      );
      if (messagesIds && messagesIds.length !== 0) {
        messagesIds.forEach(async (messagesId) => {
          const emailMessage = await getMessage(oAuth2Client, messagesId);
          handleGmailNotification(user, emailMessage, res);
        });
      }
    }
  });
  res.sendStatus(200);
});

// 서버 시작
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const axios = require("axios");
const bodyParser = require("body-parser");

const express = require("express");

const https = require("https");
const fs = require("fs");
const path = require("path");

const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");

//REST API 서버 생성
const app = express();

//포트 지정
const port = process.env.PORT || 3000;

const sslOptions = {
  key: fs.readFileSync(path.resolve("./ssl/ssl.key")),
  cert: fs.readFileSync(path.resolve("./ssl/ssl.crt")),
};

//JSON 설정
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

const server = https.createServer(sslOptions, app);

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

async function handleGmailNotification(gmail, req, res) {
  // Get the email message ID from the notification
  const messageID = req.body.message.data;

  try {
    // Fetch the email message using the Gmail API
    const emailMessage = await gmail.users.messages.get({
      userId: "me",
      id: messageID,
    });

    // Extract the necessary information from the email message
    const emailSubject = emailMessage.data.payload.headers.find(
      (header) => header.name === "Subject"
    ).value;
    const emailFrom = emailMessage.data.payload.headers.find(
      (header) => header.name === "From"
    ).value;

    console.log(`Received new email from ${emailFrom}: ${emailSubject}`);

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

    res.sendStatus(200);
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

// 웹훅 라우터
app.post("/api/gmailAPIWebhook", (req, res) => {
  console.log("동작");
  // Gmail API에서 전송된 데이터 확인
  const data = req.body;
  console.log(data);

  res.status(200).send("OK");
});

// 서버 시작
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

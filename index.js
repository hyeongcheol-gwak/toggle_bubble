const axios = require("axios");
const bodyParser = require("body-parser");
const express = require("express");
const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const port = process.env.PORT || 80;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const CLIENT_ID =
  "9447466321-9mm8v9p1ohln9dqjoeql8p7q6iemjvo0.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "https://togglecampus.org/version-test/google_email_test";

function logCompleteJsonObject(jsonObject) {
  console.log(JSON.stringify(jsonObject, null, 4));
}

async function getOAuth2Client(refreshToken) {
  const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  oAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oAuth2Client;
}

async function handleGmailNotification(user_email_a, res) {
  try {
    const bubbleApiUrl =
      "https://togglecampus.org/version-test/api/1.1/wf/receive_new_log";

    const bubbleApiKey = "8a440d780583413427646e1ac0cc374c";

    await axios.post(
      bubbleApiUrl,
      {
        user_email: user_email_a,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bubbleApiKey}`,
        },
      }
    );
  } catch (error) {
    console.error(
      "Error while sending email information to Bubble app:",
      error
    );
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

app.post("/api/users/newGmailUpdateSuccess", async (req, res) => {
  res.status(200).send({ status: "ok" });
  console.log(`Successfully update bubble DB of <${req.body.userEmail}>`);
});

app.post("/api/users/notNewGmail", async (req, res) => {
  res.status(200).send({ status: "ok" });
  console.log(`This log is not for new gmail alarm`);
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
    res.status(200).send({ status: "ok" });
    console.log(`Successfully set gmail alarm for ${req.body.userName}`);
  });
});

app.post("/api/gmailAPIWebhook", async (req, res) => {
  const base64EncodedString = req.body.message.data;
  const buffer = Buffer.from(base64EncodedString, "base64");
  const decodedString = buffer.toString("utf-8");

  const req_message_data_decoded = JSON.parse(decodedString);
  console.log(`Get new log from <${req_message_data_decoded.emailAddress}>`);

  const users = await axios.get(
    "https://togglecampus.org/version-test/api/1.1/obj/user"
  );

  users.data.response.results.forEach(async (user) => {
    if (
      user.authentication.email.email === req_message_data_decoded.emailAddress
    ) {
      handleGmailNotification(user.authentication.email.email, res);
    }
  });
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

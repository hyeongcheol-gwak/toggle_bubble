const axios = require("axios");
const bodyParser = require("body-parser");

const express = require("express");

const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const { Configuration, OpenAIApi } = require("openai");

const config = require("./config/config");

const CLIENT_ID = config.CLIENT_ID;
const CLIENT_SECRET = config.CLIENT_SECRET;
const REDIRECT_URI = config.REDIRECT_URI;

const app = express();
const port = process.env.PORT || 80;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const configuration = new Configuration({
  apiKey: config.OPENAI_API_KEY,
});

const OPENAI_API_KEY = config.OPENAI_API_KEY;
const OPENAI_API_URL =
  "https://api.openai.com/v1/engines/davinci-codex/completions";

const openAiHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${OPENAI_API_KEY}`,
};

const openai = new OpenAIApi(configuration);

async function getOAuth2Client(refreshToken) {
  try {
    const oAuth2Client = new OAuth2Client(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    oAuth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    return oAuth2Client;
  } catch (error) {
    console.error("Error while getting google oauth client:", error);
    throw error;
  }
}

async function informBubbleNewGmailLogIsArrived(userEmail, res) {
  try {
    const bubbleApiUrl =
      "https://togglecampus.org/version-test/api/1.1/wf/receive_new_log";

    const bubbleApiKey = "8a440d780583413427646e1ac0cc374c";

    await axios.post(
      bubbleApiUrl,
      {
        user_email: userEmail,
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
    throw error;
  }
}

async function getGmailContent(messageId, refreshToken) {
  try {
    const oAuth2Client = await getOAuth2Client(refreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const message = res.data;

    let bodyData;

    const { payload } = message;

    if (payload.parts && payload.parts.length > 0) {
      for (let i = 0; i < payload.parts.length; i++) {
        const part = payload.parts[i];
        if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
          bodyData = part.body.data;
          break;
        }
      }
    } else {
      bodyData = payload.body.data;
    }

    const decodedData = Buffer.from(bodyData, "base64").toString("utf-8");

    return decodedData;
  } catch (err) {
    console.error("Error while getting gmail content:", err);
    throw err;
  }
}

/*
async function getLatestEmail() {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: 1,
    // q: 'is:unread'
  });
  const message = response.data.messages[0];
  if (!message) {
    console.log("No messages found.");
    return null;
  }
  const messageResponse = await gmail.users.messages.get({
    userId: "me",
    id: message.id,
    format: "full",
  });
  return messageResponse.data;
}
*/

async function summarizeText(text) {
  const result = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `summarize the following text into one or two sentences: ${text}`,
    max_tokens: 1000,
    temperature: 0.2,
    n: 1,
  });
  const summary = result.data.choices[0].text.trim();

  return summary;
}

async function summarizeMessage(message) {
  const prompt = `summarize the information into one or two sentences: ${message}`;

  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        prompt,
        max_tokens: 100,
        n: 1,
        stop: null,
        temperature: 0.5,
      },
      { headers: openAiHeaders }
    );

    const summary = response.data.choices[0].text.trim();
    return summary;
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    return null;
  }
}

async function setGmailAlarm(user) {
  try {
    const RefreshToken = user.gmail_refresh_token;
    const oAuth2Client = await getOAuth2Client(RefreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const request = {
      labelIds: ["INBOX"],
      topicName: "projects/bubble-gmail-383603/topics/GmailAPIPush",
      userId: "me",
    };

    gmail.users.watch(request, (err) => {
      if (err) {
        console.error("Error while setting gmail alarm:", err);
      } else {
        console.log(`Set gmail alarm of ${user.name}`);
      }
    });
  } catch (error) {
    console.error("Error while setting gmail alarm:", error);
    throw error;
  }
}

async function setGmailAlarmAll() {
  try {
    const users = await axios.get(
      "https://togglecampus.org/version-test/api/1.1/obj/user"
    );

    users.data.response.results.forEach((user) => {
      if (user.gmail_refresh_token) {
        setGmailAlarm(user);
      }
    });

    console.log(`Start setting gmail alarm of all users`);

    setTimeout(() => {
      run();
    }, 604800000);
  } catch (error) {
    console.error("Error while setting gmail alarm of all users:", error);
    throw error;
  }
}

setGmailAlarmAll();

app.post("/api/openAi/summary", async (req, res) => {
  try {
    const email_infos = await axios.get(
      "https://togglecampus.org/version-test/api/1.1/obj/email_info"
    );

    const filteredEmails = email_infos.data.response.results.filter((email) => {
      const from = email.from;
      const to = email.to;
      const subject = email.subject;

      return (
        from.includes(req.body.from) &&
        to.includes(req.body.to) &&
        subject.includes(req.body.subject)
      );
    });

    if (filteredEmails[0]) {
      const summary_ = await summarizeText(filteredEmails[0].content);
      console.log(`Summarized the email from <${req.body.to}>`);
      res.status(200).send({ summary: summary_ });
    } else {
      console.log("Request for non-existent email info");
      res.status(404).send("Request for non-existent email info");
    }
  } catch (error) {
    console.error("Error processing bubble DB update of openAiSummary:", error);
    res.status(500).send("Something went wrong");
  }
});

app.post("/api/messages/getMessageContent", async (req, res) => {
  const messageId_ = req.body.messageId;
  const refreshToken_ = req.body.refreshToken;

  try {
    const message = await getGmailContent(messageId_, refreshToken_);
    res.send({ message_content: message });
  } catch (err) {
    console.error("Error getting message content:", err);
    res.status(500).send("Error getting message");
  }
});

app.post("/api/users/newGmailUpdateSuccess", async (req, res) => {
  try {
    res.status(200).send({ status: "ok" });
    console.log(`Received new email from <${req.body.userEmail}>`);
  } catch (err) {
    console.error("Error processing bubble DB update of new Gmail:", err);
    res.status(500).send("Error processing bubble DB update of new Gmail:");
  }
});

app.post("/api/users/notNewGmail", async (req, res) => {
  try {
    res.status(200).send({ status: "ok" });
    console.log(`This log is not for new gmail alarm`);
  } catch (err) {
    console.error("Error processing that it is not new Gmail alarm:", err);
    res.status(500).send("Error processing that it is not new Gmail alarm:");
  }
});

app.post("/api/users/initialGmailAlarmSet", async (req, res) => {
  try {
    const oAuth2Client = await getOAuth2Client(req.body.refreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const request = {
      labelIds: ["INBOX"],
      topicName: "projects/bubble-gmail-383603/topics/GmailAPIPush",
      userId: "me",
    };

    gmail.users.watch(request, (err) => {
      if (err) {
        console.error("Error while setting gmail alarm:", error);
        res.status(500).send(err);
      } else {
        res.status(200).send({ status: "ok" });
        console.log(`Successfully set gmail alarm for ${req.body.userName}`);
      }
    });
  } catch (error) {
    console.error("Error while setting gmail alarm:", error);
    res.status(500).send(error);
  }
});

app.post("/api/gmailAPIWebhook", async (req, res) => {
  try {
    const base64EncodedString = req.body.message.data;
    const buffer = Buffer.from(base64EncodedString, "base64");
    const decodedString = buffer.toString("utf-8");

    const req_message_data_decoded = JSON.parse(decodedString);

    const users = await axios.get(
      "https://togglecampus.org/version-test/api/1.1/obj/user"
    );

    users.data.response.results.forEach(async (user) => {
      if (
        user.authentication.email.email ===
        req_message_data_decoded.emailAddress
      ) {
        informBubbleNewGmailLogIsArrived(user.authentication.email.email, res);
      }
    });
    res.sendStatus(200);
  } catch (err) {
    console.error("Error in handling Gmail API webhook:", err);
    res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const mysql = require("mysql2");
const bodyParser = require("body-parser");
const chalk = require("chalk");

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

const openai = new OpenAIApi(configuration);

//mySql DB 연결
const connection = mysql.createConnection({
  host: config.MYSQLHOST,
  user: config.MYSQLUSER,
  password: config.MYSQLPASSWORD,
  database: config.MYSQLDATABASE,
});

//mySql DB 연결 과정이 성공했는지 실패했는지 console 창에 출력
connection.connect(function (err) {
  if (err) {
    console.error("Error connecting to database: ", err);
    return;
  }
  console.log("Database connection established successfully");
});

/**
 * gmail_refresh_token을 통해 oAuth2Client를 생성하는 함수
 * @param {string} refreshToken
 * @returns oAuth2Client
 */
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

/**
 * gmail_refresh_token을 통해 gmailClient를 생성하는 함수
 * @param {string} refreshToken
 * @returns gmailClient
 */
async function getGmailClient(refreshToken) {
  try {
    const oAuth2Client = new OAuth2Client(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    oAuth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    return gmail;
  } catch (error) {
    console.error("Error while getting google gmail client:", error);
    throw error;
  }
}

/**
 * text를 openAi를 통해 요약해서 반환하는 함수
 * @param {string} text
 * @returns 요약된 text를 반환
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

async function getGmailHistory(gmail, historyId) {
  const res = await gmail.users.history.list({
    userId: "me",
    startHistoryId: historyId,
  });
  return res.data;
}

/**
 * gmail_refresh_token을 통해 유저의 가장 최신 gmail을 추출하고 해당 gmail에서 DB 저장에 필요한 정보를 필터링하여 결과로 반환하는 함수
 * @param {string} refreshToken
 * @returns gmail_from, gmail_to, gmail_subject, gmail_content_summarized, gmail_content,
 */
async function getLatestGmail(gmail) {
  //user의 가장 최신 gmail을 추출
  const response_st = await gmail.users.messages.list({
    userId: "me",
    maxResults: 1,
  });

  //0번째가 가장 최신 gmail
  const message_st = response_st.data.messages[0];

  if (!message_st) {
    return null;
  }

  const messageResponse_st = await gmail.users.messages.get({
    userId: "me",
    id: message_st.id,
    format: "full",
  });

  const message = messageResponse_st.data;
  const { payload } = message;

  //gmail_content 추출
  let bodyData;

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

  const gmail_content_st = Buffer.from(bodyData, "base64").toString("utf-8");
  const gmail_content = gmail_content_st.replace(/\\/g, "").replace(/"/g, "");

  //gmail_content_summarized 추출
  const gmail_content_summarized_st = await summarizeText(gmail_content);
  const gmail_content_summarized = gmail_content_summarized_st
    .replace(/\\/g, "")
    .replace(/"/g, "");

  //gmail_from, gmail_to, gmail_subject 추출
  const headers = payload.headers;

  const gmail_from_st = headers.find((header) => header.name === "From").value;
  const gmail_from = gmail_from_st.replace(/\\/g, "").replace(/"/g, "");

  const gmail_to_st = headers.find((header) => header.name === "To").value;
  const gmail_to = gmail_to_st.replace(/\\/g, "").replace(/"/g, "");

  const gmail_subject_st = headers.find(
    (header) => header.name === "Subject"
  ).value;
  const gmail_subject = gmail_subject_st.replace(/\\/g, "").replace(/"/g, "");

  return {
    gmail_from,
    gmail_to,
    gmail_subject,
    gmail_content_summarized,
    gmail_content,
  };
}

/**
 * gmail을 통해 특정 gmail_user를 반환하는 함수
 * @param {string} gmail
 * @returns 특정 gmail_user
 */
async function getGmailUser(gmail) {
  return new Promise((resolve, reject) => {
    connection.query(
      "SELECT * FROM `gmail_user` WHERE `gmail` = ?",
      [gmail],
      function (error, results) {
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      }
    );
  });
}

/**
 * 모든 gmail_user를 반환하는 함수
 * @returns 모든 gmail_user
 */
async function getGmailUserAll() {
  return new Promise((resolve, reject) => {
    connection.query("SELECT * FROM `gmail_user`", function (error, results) {
      if (error) {
        reject(error);
      } else {
        resolve(results);
      }
    });
  });
}

/**
 * 특정 gmail_user의 prev_history_id의 값을 갱신하는 함수
 * @param {string} gmail
 * @param {int} historyId
 * @returns
 */
async function updateGmailUserPrevHistoryId(gmail, historyId) {
  return new Promise((resolve, reject) => {
    connection.query(
      "UPDATE `gmail_user` SET `prev_history_id` = ? WHERE `gmail` = ?",
      [historyId, gmail],
      function (error) {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * 특정 gmail_user에게 Push Notification을 설정하는 함수
 * @param {gmail_user} gmail_user
 */
async function setGmailAlarm(gmail_user) {
  try {
    const RefreshToken = gmail_user.refresh_token;
    const oAuth2Client = await getOAuth2Client(RefreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const request = {
      labelIds: [
        "CATEGORY_PERSONAL",
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
        "UNREAD",
      ],
      topicName: "projects/bubble-gmail-383603/topics/gmail_push",
      userId: "me",
    };

    gmail.users.watch(request, (err) => {
      if (err) {
        console.error("Error while setting gmail push notification:", err);
      } else {
        console.log(`Set gmail push notification of <${gmail_user.gmail}>`);
      }
    });
  } catch (error) {
    console.error("Error while setting gmail push notification:", error);
    throw error;
  }
}

/**
 * 모든 gmail_user에게 Push Notification을 설정하는 함수
 */
async function setGmailAlarmAll() {
  try {
    console.log(`Start setting gmail push notification of all gmail users`);

    const gmail_users = await getGmailUserAll();

    gmail_users.forEach((gmail_user) => {
      if (gmail_user.refresh_token) {
        setGmailAlarm(gmail_user);
      }
    });

    setTimeout(() => {
      run();
    }, 604800000);
  } catch (error) {
    console.error(
      "Error while setting gmail push notification of all gmail users:",
      error
    );
    throw error;
  }
}

setGmailAlarmAll();

//bubble.io에서 새로운 gmail_user가 가입시 처음부터 Push Notification을 설정하기 위함
app.post("/api/gmail/pushNotificationSet", async (req, res) => {
  try {
    const oAuth2Client = await getOAuth2Client(req.body.refreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const request = {
      labelIds: [
        "CATEGORY_PERSONAL",
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
        "UNREAD",
      ],
      topicName: "projects/bubble-gmail-383603/topics/gmail_push",
      userId: "me",
    };

    gmail.users.watch(request, (err) => {
      if (err) {
        console.error("Error while setting push notification:", err);
        return res.status(500).send(err);
      } else {
        console.log(`Set gmail push notification of <${req.body.gmail}>`);
        return res.status(200).send({ status: "ok" });
      }
    });
  } catch (error) {
    console.error("Error while setting gmail push notification:", error);
    return res.status(500).send(error);
  }
});

//google cloud에서 특정 gmail_user의 메일함에 새로운 log가 발생할 시 해당 webhook을 실행함
//해당 log가 새로운 메일에 의한 건지를 판단 후 새로운 메일일 경우 DB에 저장함
app.post("/webhook/gmail", async (req, res) => {
  try {
    //log의 data 추출 및 디코딩
    const base64EncodedString = req.body.message.data;
    const buffer = Buffer.from(base64EncodedString, "base64");
    const decodedString = buffer.toString("utf-8");

    const req_message_data_decoded = JSON.parse(decodedString);

    //log의 historyId 추출
    const historyId = req_message_data_decoded.historyId;

    //mysql DB에서 가져올 값에 대한 변수 선언
    let prevHistoryId = 0;
    let refreshToken = "";

    //prev_history_id 추출
    try {
      const results = await getGmailUser(req_message_data_decoded.emailAddress);

      //해당 유저의 정보가 없으면 API 종료
      if (results.length === 0) {
        return res.status(404);
      }

      //해당 유저의 정보가 있으면 위에서 선언한 mysql DB에서 가져올 값에 대한 변수에 저장
      prevHistoryId = results[0].prev_history_id;
      refreshToken = results[0].refresh_token;
    } catch (error) {
      console.error("Error getting gmail user:", error);
      return res.status(500).send("Error getting gmail user");
    }

    //webhook을 호출하는 모든 log 확인
    console.log(
      `gmail: ${req_message_data_decoded.emailAddress}, historyId: ${historyId}, prevHistoryId: ${prevHistoryId}`
    );

    //새로운 메일, 즉 (historyId > prevHistoryId)일 경우 해당 유저의 prev_history_id 갱신 && 새로운 메일이 아닐 경우 API 종료
    if (historyId > prevHistoryId) {
      try {
        await updateGmailUserPrevHistoryId(
          req_message_data_decoded.emailAddress,
          historyId
        );
      } catch (error) {
        console.error("Error updating gmail_user_prev_history_id:", error);

        return res
          .status(500)
          .send("Error updating gmail_user_prev_history_id");
      }
    } else {
      //새로운 메일이 아닐 경우 API 종료
      return res.status(404);
    }

    // //webhook을 호출하는 유의미한 log 확인
    // console.log(
    //   chalk.yellow(
    //     `gmail: ${req_message_data_decoded.emailAddress}, historyId: ${historyId}, prevHistoryId: ${prevHistoryId}`
    //   )
    // );

    const gmail = await getGmailClient(refreshToken);

    //HistoryId가 아닌 prevHistoryId를 사용하는 이유는 무척 복잡하니 생략
    const data = await getGmailHistory(gmail, prevHistoryId);

    const messagesAdded = data.history[0].messagesAdded;

    //새로 받은 메일의 경우는 messagesAdded가 존재함
    //이메일 임시보관함에 생성된 메일이 DB에 저장되는 것을 방지
    if (!messagesAdded) {
      return res.status(404);
    }

    const hasPersonalCategory = messagesAdded.some(({ message }) =>
      message.labelIds.includes("CATEGORY_PERSONAL")
    );

    const hasSocialCategory = messagesAdded.some(({ message }) =>
      message.labelIds.includes("CATEGORY_SOCIAL")
    );

    const hasPromotionsCategory = messagesAdded.some(({ message }) =>
      message.labelIds.includes("CATEGORY_PROMOTIONS")
    );
    const hasUpdatesCategory = messagesAdded.some(({ message }) =>
      message.labelIds.includes("CATEGORY_UPDATES")
    );
    const hasForumsCategory = messagesAdded.some(({ message }) =>
      message.labelIds.includes("CATEGORY_FORUMS")
    );

    //특정 카테고리의 메일함에 들어 온 메일만 확인
    if (
      !hasPersonalCategory &&
      !hasSocialCategory &&
      !hasPromotionsCategory &&
      !hasUpdatesCategory &&
      !hasForumsCategory
    ) {
      return res.status(404);
    }

    //새로운 메일의 정보 추출
    const message = await getLatestGmail(gmail);

    //데이터 베이스에 저장
    if (
      message.gmail_from &&
      message.gmail_to &&
      message.gmail_subject &&
      message.gmail_content &&
      message.gmail_content_summarized
    ) {
      connection.query(
        "INSERT INTO `gmail_collected` (`from`, `to`, `subject`, `content`, `content_summarized`) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `content_summarized` = VALUES(`content_summarized`), `created_date` = CURRENT_TIMESTAMP",
        [
          message.gmail_from,
          message.gmail_to,
          message.gmail_subject,
          message.gmail_content,
          message.gmail_content_summarized,
        ],
        function (error) {
          if (error) throw error;
          console.log(`Get new gmail of ${message.gmail_to}`);
        }
      );
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Error in handling Gmail API webhook:", err);
    return res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

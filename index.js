const mysql = require("mysql2");
const bodyParser = require("body-parser");

const express = require("express");

const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");

const { Configuration, OpenAIApi } = require("openai");

const config = require("./config/config");
const logger = require("./logger");

const CLIENT_ID = config.CLIENT_ID;
const CLIENT_SECRET = config.CLIENT_SECRET;
const REDIRECT_URI = config.REDIRECT_URI;

const app = express();
const port = process.env.PORT || 80;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/**
 * gmail_refresh_token을 통해 oAuth2Client를 생성하는 함수
 * @param {string} refreshToken
 * @returns oAuth2Client
 */
async function getOAuth2Client(refreshToken) {
  const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  oAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oAuth2Client;
}

/**
 * gmail_refresh_token을 통해 gmailClient를 생성하는 함수
 * @param {string} refreshToken
 * @returns gmailClient
 */
async function getGmailClient(refreshToken) {
  const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  oAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  return gmail;
}

/**
 * gmail_client와 특정 로그의 history_id를 통해 해당 history의 상세 내용을 반환하는 함수
 * @param {gmail_client} gmail
 * @param {int} historyId
 * @returns 해당 history의 상세 내용
 */
async function getGmailHistory(gmail, historyId) {
  const res = await gmail.users.history.list({
    userId: "me",
    startHistoryId: historyId,
  });
  return res.data;
}

/**
 * text를 openAi를 통해 요약해서 반환하는 함수
 * @param {string} text
 * @returns 요약된 text를 반환
 */
async function summarizeText(text) {
  const configuration = new Configuration({
    apiKey: config.OPENAI_API_KEY,
  });

  const openai = new OpenAIApi(configuration);

  //해당 propmt는 공식 문서에 따라 작성된 것임
  const result = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `Summarize the following text in one or two sentences:\n\n${text}`,
    temperature: 0.7,
    max_tokens: 64,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
    n: 1,
  });
  const summary = result.data.choices[0].text.trim();

  return summary;
}

async function actionNeeded(text) {
  const configuration = new Configuration({
    apiKey: config.OPENAI_API_KEY,
  });

  const openai = new OpenAIApi(configuration);

  const result = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `Answer "yes" or "no". Decide whether additional actions such as replies are needed or not in the following text::\n\n${text}`,
    temperature: 0,
    max_tokens: 64,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
    n: 1,
    stop: ["yes", "no"],
  });
  const is_true =
    result.data.choices[0].text.trim().toLowerCase() === "yes" ? 1 : 0;
  return is_true;
}

async function eventPlanned(text) {
  const configuration = new Configuration({
    apiKey: config.OPENAI_API_KEY,
  });

  const openai = new OpenAIApi(configuration);

  const result = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `Answer "yes" or "no". Decide whether additional actions such as making or modifying a schedule are needed or not after reading the following text::\n\n${text}`,
    temperature: 0,
    max_tokens: 64,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
    n: 1,
    stop: ["yes", "no"],
  });
  console.log(text);
  console.log(result.data.choices[0].text.trim());
  const is_true =
    result.data.choices[0].text.trim().toLowerCase() === "yes" ? 1 : 0;

  return is_true;
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
    gmail_content,
  };
}

/**
 * gmail을 통해 특정 gmail_user를 반환하는 함수
 * @param {string} gmail
 * @returns 특정 gmail_user
 */
async function getGmailUser(gmail) {
  //mySql DB 연결
  const connection = mysql.createConnection({
    host: config.MYSQLHOST,
    user: config.MYSQLUSER,
    password: config.MYSQLPASSWORD,
    database: config.MYSQLDATABASE,
  });

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
    connection.end();
  });
}

/**
 * 모든 gmail_user를 반환하는 함수
 * @returns 모든 gmail_user
 */
async function getGmailUserAll() {
  //mySql DB 연결
  const connection = mysql.createConnection({
    host: config.MYSQLHOST,
    user: config.MYSQLUSER,
    password: config.MYSQLPASSWORD,
    database: config.MYSQLDATABASE,
  });

  return new Promise((resolve, reject) => {
    connection.query("SELECT * FROM `gmail_user`", function (error, results) {
      if (error) {
        reject(error);
      } else {
        resolve(results);
      }
    });
    connection.end();
  });
}

/**
 * 특정 gmail_user의 prev_history_id의 값을 갱신하는 함수
 * @param {string} gmail
 * @param {int} historyId
 * @returns
 */
async function updateGmailUserPrevHistoryId(gmail, historyId) {
  //mySql DB 연결
  const connection = mysql.createConnection({
    host: config.MYSQLHOST,
    user: config.MYSQLUSER,
    password: config.MYSQLPASSWORD,
    database: config.MYSQLDATABASE,
  });

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
    connection.end();
  });
}

/**
 * 특정 gmail_user에게 Push Notification을 설정하는 함수
 * @param {gmail_user} gmail_user
 */
async function setGmailAlarm(gmail_user) {
  const RefreshToken = gmail_user.refresh_token;
  const oAuth2Client = await getOAuth2Client(RefreshToken);
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  //이유는 모르겠으나, "UNREAD"는 반드시 있어야 함
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
      throw err;
    } else {
      logger.info(`Set gmail push notification of <${gmail_user.gmail}>`);
    }
  });
}

/**
 * 모든 gmail_user에게 Push Notification을 설정하는 함수
 */
async function setGmailAlarmAll() {
  try {
    const gmail_users = await getGmailUserAll();

    gmail_users.forEach((gmail_user) => {
      if (gmail_user.refresh_token) {
        setGmailAlarm(gmail_user);
      }
    });

    logger.info(`Start setting gmail push notification of all gmail users`);

    setTimeout(() => {
      setGmailAlarmAll();
    }, 604800000);
  } catch (error) {
    logger.error(
      "While of all gmail users setting gmail push notification:",
      error
    );
    throw error;
  }
}

setGmailAlarmAll();

//bubble.io에서 새로운 gmail_user가 가입시 처음부터 Push Notification을 설정하기 위함
//이유는 모르겠으나, setGmailAlarm()으로 해당 API를 구현할 시 버블에서는 오류가 발생함
app.post("/api/gmail/pushNotificationSet", async (req, res) => {
  try {
    const oAuth2Client = await getOAuth2Client(req.body.refreshToken);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    //이유는 모르겠으나, "UNREAD"는 반드시 있어야 함
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
        throw err;
      } else {
        logger.info(`Set gmail push notification of <${req.body.gmail}>`);
        return res.status(200).send({ status: "ok" });
      }
    });
  } catch (error) {
    logger.error("While on API setting gmail push notification:", error);
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

    //log를 발생시킨 유저의 prev_history_id, refreshToken 그리고 bubbleEmail 추출
    let prevHistoryId = 0;
    let refreshToken = "";
    let bubbleEmail = "";
    try {
      const results = await getGmailUser(req_message_data_decoded.emailAddress);

      //해당 유저의 정보가 없으면 API 종료
      if (results.length === 0) {
        return res.status(200);
      }

      //해당 유저의 정보가 있으면 위에서 선언한 변수에 저장
      prevHistoryId = results[0].prev_history_id;
      refreshToken = results[0].refresh_token;
      bubbleEmail = results[0].bubble_email;
    } catch (error) {
      logger.error("While getting gmail user:", error);
      return res.status(500).send("Error while getting gmail user");
    }

    ////////////////
    // //webhook을 호출하는 모든 log 확인
    // console.log(
    //   `gmail: ${req_message_data_decoded.emailAddress}, historyId: ${historyId}, prevHistoryId: ${prevHistoryId}`
    // );
    ////////////////

    //유의미한 로그, 즉 (historyId > prevHistoryId)일 경우 이하의 과정을 진행
    //유의미한 로그가 아닐 경우, 즉 (historyId <= prevHistoryId)일 경우라도 else에 "return res.status(404) 등을 넣어 강제로 API를 종료하면 안됨
    if (historyId > prevHistoryId) {
      //webhook을 호출하는 유의미한 log를 콘솔 창에 출력
      logger.info(
        `gmail: ${req_message_data_decoded.emailAddress}, historyId: ${historyId}, prevHistoryId: ${prevHistoryId}`
      );

      //gmail_user의 prev_history_id를 유의미한 log에 대한 history_id로 변경
      try {
        await updateGmailUserPrevHistoryId(
          req_message_data_decoded.emailAddress,
          historyId
        );
      } catch (error) {
        logger.error("While updating gmail_user_prev_history_id:", error);
        return res
          .status(500)
          .send("Error while updating gmail_user_prev_history_id");
      }

      //gmail_client를 생성
      let gmail;
      try {
        gmail = await getGmailClient(refreshToken);
      } catch (error) {
        logger.error("While getting google gmail client:", error);
        return res.status(500).send("Error while getting google gmail client");
      }

      ////////////////
      // //수신한 메일의 경우 messagesAdded가 존재함
      // //prevData와 data 모두에서 messagesAdded가 존재하지 않을 경우 API 종료
      // const prevData = await getGmailHistory(gmail, prevHistoryId);
      // const data = await getGmailHistory(gmail, historyId);

      // let messagesAdded = null;

      // if (prevData.history && prevData.history[0].messagesAdded) {
      //   messagesAdded = prevData.history[0].messagesAdded;
      // } else if (data.history && data.history[0].messagesAdded) {
      //   messagesAdded = data.history[0].messagesAdded;
      // } else {
      //   return res.status(404);
      // }

      // //특정 카테고리의 메일함에 들어 온 메일이 아닐 경우 API 종료
      // const hasPersonalCategory = messagesAdded.some(({ message }) =>
      //   message.labelIds.includes("CATEGORY_PERSONAL")
      // );

      // const hasSocialCategory = messagesAdded.some(({ message }) =>
      //   message.labelIds.includes("CATEGORY_SOCIAL")
      // );

      // const hasPromotionsCategory = messagesAdded.some(({ message }) =>
      //   message.labelIds.includes("CATEGORY_PROMOTIONS")
      // );
      // const hasUpdatesCategory = messagesAdded.some(({ message }) =>
      //   message.labelIds.includes("CATEGORY_UPDATES")
      // );
      // const hasForumsCategory = messagesAdded.some(({ message }) =>
      //   message.labelIds.includes("CATEGORY_FORUMS")
      // );

      // if (
      //   !hasPersonalCategory &&
      //   !hasSocialCategory &&
      //   !hasPromotionsCategory &&
      //   !hasUpdatesCategory &&
      //   !hasForumsCategory
      // ) {
      //   return res.status(404);
      // }
      ////////////////

      //새로운 메일의 정보 추출
      let message;
      try {
        message = await getLatestGmail(gmail);
      } catch (error) {
        logger.error("While getting latest gmail:", error);
        return res.status(500).send("Error while getting latest gmail");
      }

      ////////////////
      // //중복되는 메일 데이터의 경우 DB에 저장하지 않고 API 종료
      // if (
      //   message.gmail_from &&
      //   message.gmail_to &&
      //   message.gmail_subject &&
      //   message.gmail_content
      // ) {
      //   connection.query(
      //     "SELECT * FROM `gmail_collected` WHERE `from` = ? AND `to` = ? AND `subject` = ? AND `content` = ?",
      //     [
      //       message.gmail_from,
      //       message.gmail_to,
      //       message.gmail_subject,
      //       message.gmail_content,
      //     ],
      //     function (error, results) {
      //       if (error) throw error;
      //       if (results.length > 0) {
      //         console.log(
      //           "\x1b[31m%s\x1b[0m",
      //           `Get duplicated gmail of ${message.gmail_to}`
      //         );
      //         return;
      //       }
      //     }
      //   );
      // }
      ////////////////

      //from에 해당하는 gmail_user가 mysql DB gmail_user 테이블에 존재하는 경우, from에 해당하는 gmail_user가 임시 보관함에 올린 글이 gmail_collected에 저장되는 오류를 방지
      const gmailFrom_ = message.gmail_from.replace(/.*<(.*)>/, "$1");

      if (req_message_data_decoded.emailAddress == gmailFrom_) {
        return res.sendStatus(200);
      }

      //gmail_content_summarized 추출
      let gmail_content_summarized;
      try {
        const gmail_content_summarized_st = await summarizeText(
          message.gmail_content
        );
        gmail_content_summarized = gmail_content_summarized_st
          .replace(/\\/g, "")
          .replace(/"/g, "");
      } catch (error) {
        logger.error("While summarizing gmail content:", error);
        return res.status(500).send("Error while summarizing gmail content");
      }

      //isActionNeeded 추출
      let isActionNeeded;
      try {
        isActionNeeded = await actionNeeded(message.gmail_content);
      } catch (error) {
        logger.error(
          "While deciding whether or not action is needed in gmail content:",
          error
        );
        return res
          .status(500)
          .send(
            "Error While deciding whether or not action is needed in gmail content"
          );
      }
      console.log(isActionNeeded);

      //isEventPlanned 추출
      let isEventPlanned;
      try {
        isEventPlanned = await eventPlanned(message.gmail_content);
      } catch (error) {
        logger.error(
          "While deciding whether or not event is planned in gmail content:",
          error
        );
        return res
          .status(500)
          .send(
            "Error While deciding whether or not event is planned in gmail content"
          );
      }

      //mySql DB 연결
      const connection = mysql.createConnection({
        host: config.MYSQLHOST,
        user: config.MYSQLUSER,
        password: config.MYSQLPASSWORD,
        database: config.MYSQLDATABASE,
      });

      //새로운 메일 데이터의 경우 DB에 저장
      try {
        if (
          message.gmail_from &&
          message.gmail_to &&
          message.gmail_subject &&
          message.gmail_content &&
          gmail_content_summarized
        ) {
          connection.query(
            "INSERT INTO `gmail_collected` (`from`, `to`, `subject`, `content`, `content_summarized`, `bubble_email`, `is_action_needed`, `is_event_planned`) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `content_summarized` = VALUES(`content_summarized`), `created_date` = CURRENT_TIMESTAMP",
            [
              message.gmail_from,
              message.gmail_to,
              message.gmail_subject,
              message.gmail_content,
              gmail_content_summarized,
              bubbleEmail,
              isActionNeeded,
              isEventPlanned,
            ],
            function (error) {
              if (error) throw error;
              logger.info(`Get new gmail of ${message.gmail_to}`);
            }
          );
        }
      } catch (error) {
        logger.error("While storing new gmail:", error);
        return res.status(500).send("Error while storing new gmail");
      }
      connection.end();
    }
    return res.sendStatus(200);
  } catch (err) {
    logger.error("In handling Gmail API webhook:", err);
    return res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log("\x1b[32m%s\x1b[0m", `Server listening on port ${port}`);
});

const AccessToken = require("twilio").jwt.AccessToken;
const { SyncGrant, VideoGrant } = AccessToken;
const TokenValidator = require("twilio-flex-token-validator").functionValidator;
const ParameterValidator = require(Runtime.getFunctions()[
  "common/helpers/parameter-validator"
].path);
const SyncOperations = require(Runtime.getFunctions()[
  "common/twilio-wrappers/sync"
].path);

exports.handler = TokenValidator(async function agentGetToken(
  context,
  event,
  callback
) {
  console.log("----- agentGetToken -----");
  const scriptName = arguments.callee.name;
  const response = new Twilio.Response();
  const requiredParameters = [
    { key: "DocumentSid", purpose: "used for sync document" },
  ];
  const parameterError = ParameterValidator.validate(
    context.PATH,
    event,
    requiredParameters
  );

  response.appendHeader("Access-Control-Allow-Origin", "*");
  response.appendHeader("Access-Control-Allow-Methods", "OPTIONS POST");
  response.appendHeader("Content-Type", "application/json");
  response.appendHeader("Access-Control-Allow-Headers", "Content-Type");

  if (Object.keys(event).length === 0) {
    console.log("Empty event object, likely an OPTIONS request");
    return callback(null, response);
  }

  if (parameterError) {
    response.setStatusCode(400);
    response.setBody({ data: null, message: parameterError });
    callback(null, response);
  } else {
    try {
      const { DocumentSid: document_sid } = event;
      const client = context.getTwilioClient();

      const documentData = await SyncOperations.fetchDocument({
        scriptName,
        attempts: 0,
        context,
        documentSid: document_sid,
      });

      if (!documentData) {
        response.setStatusCode(403);
        response.setBody({ error: `Invalid document SID.` });
        console.log(response);
        return callback(null, response);
      }

      const { document } = documentData;

      // Check if the video room is already created
      let room_name = document.data.room;
      if (!room_name) {
        // If not, then create it
        const room_created = await client.video.rooms
          .create({
            recordParticipantsOnConnect: context.VIDEO_RECORD_BY_DEFAULT,
            type: context.VIDEO_ROOM_TYPE,
          })
          .then((room) => {
            room_name = room.sid;
            console.log(document.sid, room.sid);
            return { ...document.data, room: room.sid };
          })
          .then((new_document_data) =>
            SyncOperations.updateDocumentData({
              scriptName,
              attempts: 0,
              context,
              documentSid: document_sid,
              updateData: new_document_data,
            })
          )
          .catch((reason) => false);

        if (!room_created) {
          response.setStatusCode(503);
          response.setBody({ error: `Error starting video.` });
          return callback(null, response);
        }
      }

      // We use the agent's FLEX identity
      const agent_identity = event.TokenResult.identity;

      /*
        - Authorize the agent Frontend to connect to SYNC
        - Note: not  directly utilized in this implementation
      */
      const syncGrant = new SyncGrant({
        serviceSid: context.TWILIO_FLEX_SYNC_SID,
      });

      // Authorize the agent Frontend to connect to VIDEO
      const videoGrant = new VideoGrant({
        room: room_name,
      });

      // Create an access token which we will sign and return to the agent,
      const token = new AccessToken(
        context.ACCOUNT_SID,
        context.TWILIO_API_KEY,
        context.TWILIO_API_SECRET,
        { identity: agent_identity }
      );
      token.addGrant(syncGrant);
      token.addGrant(videoGrant);

      // Respond to the AGENT frontend with a dual-use token (sync + video)
      response.setBody({ token: token.toJwt() });

      callback(null, response);
    } catch (error) {
      console.error(`Unexpected error occurred in ${scriptName}: ${error}`);
      response.setStatusCode(500);
      response.setBody({ success: false, message: error });
      callback(null, response);
    }
  }
});

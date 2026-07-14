// Separate PM2 process (see ecosystem.config.js) — keeps worker crashes from
// taking down the API process and vice versa.
import "./faceDetection.worker";
import "./holdingSpaceDrain.worker";
import "./transcription.worker";
import "./voiceCloning.worker";
import "./embedding.worker";
import "./notification.worker";

// eslint-disable-next-line no-console
console.log("myFamiPedia workers started");

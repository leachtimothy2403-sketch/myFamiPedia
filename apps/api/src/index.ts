import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";

import { authRouter } from "./routes/auth.routes";
import { personsRouter } from "./routes/persons.routes";
import { memoriesRouter } from "./routes/memories.routes";
import { collectionRouter } from "./routes/collection.routes";
import { interviewsRouter } from "./routes/interviews.routes";
import { invitationsRouter } from "./routes/invitations.routes";
import { voiceRouter } from "./routes/voice.routes";
import { searchRouter } from "./routes/search.routes";
import { moderationRouter } from "./routes/moderation.routes";
import { subscriptionRouter } from "./routes/subscription.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { uploadsRouter } from "./routes/uploads.routes";
import { photosRouter } from "./routes/photos.routes";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const v1 = express.Router();
v1.use("/auth", authRouter);
v1.use(personsRouter);
v1.use(memoriesRouter);
v1.use(collectionRouter);
v1.use(interviewsRouter);
v1.use(invitationsRouter);
v1.use(voiceRouter);
v1.use(searchRouter);
v1.use(moderationRouter);
v1.use(subscriptionRouter);
v1.use(notificationsRouter);
v1.use(uploadsRouter);
v1.use(photosRouter);
app.use("/api/v1", v1);

app.use(errorHandler);

// Tests import this module purely to get the `app` object for supertest —
// they set up their own pglite-backed DATABASE_URL and never want a real
// listener bound (it would also fight over ports across parallel test files).
if (env.nodeEnv !== "test") {
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`myFamiPedia API listening on :${env.port}`);
  });
}

export default app;

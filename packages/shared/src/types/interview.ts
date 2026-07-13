// childhood, education, work, relationships, family, values, legacy
export type LifePhase = "childhood" | "education" | "work" | "relationships" | "family" | "values" | "legacy";

export interface InterviewQuestion {
  id: string;
  text: string;
  lifePhase: LifePhase;
  sortOrder: number | null;
}

export type InterviewSessionStatus = "in_progress" | "completed";

export interface InterviewSession {
  id: string;
  personId: string;
  facilitatorPersonId: string;
  status: InterviewSessionStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface InterviewAnswer {
  id: string;
  sessionId: string;
  questionId: string;
  audioR2Key: string;
  transcript: string | null;
  memoryId: string | null; // linked once transcribed
  createdAt: string;
}

import type { Person } from "@myfamipedia/shared";

interface ProfileHeaderProps {
  person: Person;
}

export function ProfileHeader({ person }: ProfileHeaderProps) {
  return (
    <header>
      <h1>{person.name}</h1>
      {person.aiSummary ? (
        <p>
          <em>AI-generated summary</em>: {person.aiSummary}
        </p>
      ) : null}
    </header>
  );
}

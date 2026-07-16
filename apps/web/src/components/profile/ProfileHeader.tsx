import type { Person } from "@myfamipedia/shared";

interface ProfileHeaderProps {
  person: Person;
}

const STATUS_LABEL: Record<Person["status"], string> = {
  active: "Active",
  invited_pending: "Invitation pending",
  declined_grace: "Declined (grace period)",
  opted_out: "Opted out",
  deceased: "In memoriam",
};

function lifespan(person: Person): string | null {
  const birthYear = person.birthDate?.slice(0, 4);
  const deathYear = person.deathDate?.slice(0, 4);
  if (!birthYear && !deathYear) return null;
  if (person.status === "deceased") return `${birthYear ?? "?"} – ${deathYear ?? "?"}`;
  return birthYear ? `Born ${birthYear}` : null;
}

export function ProfileHeader({ person }: ProfileHeaderProps) {
  const years = lifespan(person);
  return (
    <header style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0 }}>{person.name}</h1>
        <span
          style={{
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 999,
            background: person.status === "deceased" ? "#e5e5e5" : "#e8f0fe",
            color: person.status === "deceased" ? "#555" : "#1a73e8",
          }}
        >
          {STATUS_LABEL[person.status] ?? person.status}
        </span>
      </div>
      {years ? <p style={{ color: "#666", margin: "4px 0" }}>{years}</p> : null}
      {person.aiSummary ? (
        <p style={{ background: "#fafafa", padding: 12, borderRadius: 8 }}>
          <em>AI-generated summary</em>: {person.aiSummary}
        </p>
      ) : null}
    </header>
  );
}

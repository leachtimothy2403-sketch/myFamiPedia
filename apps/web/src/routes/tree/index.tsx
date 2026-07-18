import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useFamilyTree } from "../../hooks/useFamilyTree";
import { TreeCanvas } from "../../components/tree/TreeCanvas";
import { AddFamilyMemberPanel } from "../../components/tree/AddFamilyMemberPanel";
import { apiClient } from "../../lib/apiClient";
import { getFamilyGroupId, getPersonId } from "../../lib/session";

// Primary canvas: pan/zoom graph, generational layout. This is the tree's
// full interactive treatment — mobile's tree.tsx is a simplified read-mostly
// view of the same data (see docs/web_app_structure.md intro).
export default function TreeRoute() {
  const navigate = useNavigate();
  const familyGroupId = getFamilyGroupId();
  const personId = getPersonId();
  const { data, isLoading, isError, error, refetch } = useFamilyTree(familyGroupId ?? "");
  const [showAddPanel, setShowAddPanel] = useState(false);

  async function onLogout() {
    await apiClient.logout().catch(() => undefined);
    navigate("/login", { replace: true });
  }

  const persons = data?.persons ?? [];
  const relationships = data?.relationships ?? [];

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          borderBottom: "1px solid #e0e0e0",
        }}
      >
        <strong>myFamiPedia</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link to="/search">Search</Link>
          <button onClick={() => setShowAddPanel((v) => !v)} disabled={isLoading || isError}>
            + Add family member
          </button>
          <button onClick={onLogout}>Log out</button>
        </div>
      </header>

      <div style={{ flex: 1, position: "relative" }}>
        {isLoading ? (
          <div style={{ padding: 40 }}>Loading your family tree…</div>
        ) : isError ? (
          <div style={{ padding: 40 }}>
            <p>Couldn't load the tree: {error instanceof Error ? error.message : "unknown error"}</p>
            <button onClick={() => refetch()}>Try again</button>
          </div>
        ) : (
          <>
            <TreeCanvas
              persons={persons}
              relationships={relationships}
              rootPersonId={personId}
              onSelectPerson={(id) => navigate(`/person/${id}`)}
            />
            {showAddPanel ? (
              <AddFamilyMemberPanel
                familyGroupId={familyGroupId ?? ""}
                persons={persons}
                defaultRelatedToId={personId}
                onClose={() => setShowAddPanel(false)}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

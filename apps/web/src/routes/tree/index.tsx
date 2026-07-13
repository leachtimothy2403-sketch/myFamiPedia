import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFamilyTree } from "../../hooks/useFamilyTree";
import { TreeCanvas } from "../../components/tree/TreeCanvas";

// Primary canvas: pan/zoom graph, generational layout. This is the tree's
// full interactive treatment — mobile's tree.tsx is a simplified read-mostly
// view of the same data (see docs/web_app_structure.md intro).
export default function TreeRoute() {
  const navigate = useNavigate();
  const { data } = useFamilyTree("me");
  const [_zoom, setZoom] = useState(1);

  const persons = (data as any)?.persons ?? [];
  const relationships = (data as any)?.relationships ?? [];

  return (
    <div style={{ height: "100vh" }}>
      <TreeCanvas
        persons={persons}
        relationships={relationships}
        onSelectPerson={(id) => navigate(`/person/${id}`)}
      />
    </div>
  );
}

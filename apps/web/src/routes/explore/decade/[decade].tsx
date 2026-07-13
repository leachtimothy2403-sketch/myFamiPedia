import { useParams } from "react-router-dom";

// The "the 1960s in our family" card grid — desktop equivalent of mobile
// tree.tsx's "By decade" mode.
export default function ExploreDecadeRoute() {
  const { decade = "" } = useParams<{ decade: string }>();
  return (
    <div style={{ padding: 24 }}>
      <h1>The {decade}s in our family</h1>
      <p>Memories and photos from this decade render here.</p>
    </div>
  );
}

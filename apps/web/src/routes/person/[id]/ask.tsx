import { useParams } from "react-router-dom";
import { AskPanel } from "../../../components/profile/AskPanel";

export default function PersonAskRoute() {
  const { id = "" } = useParams<{ id: string }>();
  return (
    <div style={{ padding: 24 }}>
      <AskPanel personId={id} />
    </div>
  );
}

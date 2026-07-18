import { useMemo, useState } from "react";
import { View } from "react-native";
import Svg from "react-native-svg";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withDecay } from "react-native-reanimated";
import type { Person, Relationship } from "@myfamipedia/shared";
import { PersonNode } from "./PersonNode";
import { RelationshipEdge } from "./RelationshipEdge";
import { layoutFamilyTree } from "../../lib/treeLayout";

interface TreeCanvasProps {
  persons: Person[];
  relationships: Relationship[];
  rootPersonId?: string | null;
  onSelectPerson?: (personId: string) => void;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const CONTENT_PADDING = 80;

// Mobile port of apps/web/src/components/tree/TreeCanvas.tsx — same
// generational layout (lib/treeLayout.ts) and the same two child components,
// but pan/pinch driven by react-native-gesture-handler + react-native-
// reanimated (both already dependencies, for the drawer nav / other gesture
// work) instead of mouse/wheel handlers, and rendered with react-native-svg
// instead of a DOM <svg>. Requires `npx expo install react-native-svg` —
// Expo Go for SDK 54 bundles it, but it still needs to be a declared
// dependency for the dev build / any future custom build to include it.
//
// The transform (pan position + zoom scale) is applied to the wrapping
// Animated.View, not re-computed into the SVG's own coordinates — the Svg's
// content is laid out once per persons/relationships change and is otherwise
// static, which keeps pan/zoom smooth (native-thread transform, no re-render
// of the SVG tree on every gesture frame).
export function TreeCanvas({ persons, relationships, rootPersonId, onSelectPerson }: TreeCanvasProps) {
  const { positions, width, height } = useMemo(
    () => layoutFamilyTree(persons, relationships, rootPersonId ?? null),
    [persons, relationships, rootPersonId]
  );

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const savedScale = useSharedValue(1);

  const panGesture = Gesture.Pan()
    .minDistance(10)
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd((e) => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      translateX.value = withDecay({ velocity: e.velocityX, deceleration: 0.995 });
      translateY.value = withDecay({ velocity: e.velocityY, deceleration: 0.995 });
    })
    .onFinalize(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      const next = savedScale.value * e.scale;
      scale.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const composedGesture = Gesture.Simultaneous(panGesture, pinchGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const contentWidth = width + CONTENT_PADDING * 2;
  const contentHeight = height + CONTENT_PADDING * 2;
  const centerX = contentWidth / 2;

  if (persons.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Animated.Text style={{ color: "#666" }}>No one in the tree yet.</Animated.Text>
      </View>
    );
  }

  return (
    <View
      style={{ flex: 1, overflow: "hidden", backgroundColor: "#fafafa" }}
      onLayout={(e) => setContainerSize(e.nativeEvent.layout)}
    >
      <GestureDetector gesture={composedGesture}>
        <Animated.View
          style={[
            {
              width: contentWidth,
              height: contentHeight,
              // Start roughly centered in the visible container rather than
              // pinned to the top-left corner.
              marginLeft: -contentWidth / 2 + containerSize.width / 2,
              marginTop: -CONTENT_PADDING,
            },
            animatedStyle,
          ]}
        >
          <Svg width={contentWidth} height={contentHeight}>
            {relationships.map((r) => {
              const from = positions.get(r.personAId);
              const to = positions.get(r.personBId);
              if (!from || !to) return null;
              return (
                <RelationshipEdge
                  key={r.id}
                  relationship={r}
                  x1={from.x + centerX}
                  y1={from.y + CONTENT_PADDING}
                  x2={to.x + centerX}
                  y2={to.y + CONTENT_PADDING}
                />
              );
            })}
            {[...positions.values()].map(({ person, x, y }) => (
              <PersonNode
                key={person.id}
                person={person}
                x={x + centerX}
                y={y + CONTENT_PADDING}
                isRoot={person.id === rootPersonId}
                onSelect={onSelectPerson}
              />
            ))}
          </Svg>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

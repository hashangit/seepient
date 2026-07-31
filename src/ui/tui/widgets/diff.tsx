import React from 'react';
import { Text } from 'ink';
import { DiffViewer } from '../components/diff-viewer.js';
import type { WidgetSpec } from './types.js';

export const DiffWidget = React.memo(function DiffWidget({ spec }: { spec: WidgetSpec }) {
  const oldContent = spec.props.oldContent as string | null | undefined;
  const newContent = spec.props.newContent as string | undefined;
  if (newContent === undefined) return <Text color="gray">(no diff content)</Text>;
  return <DiffViewer oldContent={oldContent ?? null} newContent={newContent} expanded={true} />;
});

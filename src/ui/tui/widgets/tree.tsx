import React from 'react';
import { Box, Text } from 'ink';
import type { WidgetSpec } from './types.js';

interface TreeNode { label: string; children?: TreeNode[]; }

function renderTree(node: TreeNode, depth: number = 0, last: boolean[] = [], idx: number = 0): React.ReactNode[] {
  const prefix = depth === 0 ? '' : last.slice(0, -1).map((l) => l ? '    ' : '│   ').join('') + (last[last.length - 1] ? '└── ' : '├── ');
  // Position-based key: unique by path in the tree, so duplicate sibling labels
  // (e.g. two folders named "src") don't collide.
  const nodes: React.ReactNode[] = [<Text key={`${depth}-${idx}`}>{prefix}{node.label}</Text>];
  if (node.children) {
    node.children.forEach((child, i) => {
      nodes.push(...renderTree(child, depth + 1, [...last, i === (node.children?.length ?? 1) - 1], i));
    });
  }
  return nodes;
}

export const TreeWidget = React.memo(function TreeWidget({ spec }: { spec: WidgetSpec }) {
  const root = spec.props.root as TreeNode | undefined;
  if (!root) return <Text color="gray">(empty tree)</Text>;
  return (
    <Box flexDirection="column">
      {renderTree(root)}
    </Box>
  );
});

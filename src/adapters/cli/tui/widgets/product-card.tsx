import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { WidgetSpec } from './types.js';

function stars(rating: number | undefined): string {
  if (!rating) return '';
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
}

export const ProductCardWidget = React.memo(function ProductCardWidget({ spec }: {
  spec: WidgetSpec;
}) {
  const theme = useTheme();
  const title = typeof spec.props.title === 'string' ? spec.props.title : String(spec.props.title ?? '');
  const subtitle = typeof spec.props.subtitle === 'string' ? spec.props.subtitle : undefined;
  const price = typeof spec.props.price === 'string' ? spec.props.price : undefined;
  // LLMs often pass rating as a string ("4.5"); coerce to a finite number.
  const rawRating = Number(spec.props.rating);
  const rating = Number.isFinite(rawRating) && spec.props.rating != null ? rawRating : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{title}</Text>
        {price ? <Text color={theme.green}> {price}</Text> : null}
      </Box>
      {subtitle ? <Text color={theme.fgDim}>{subtitle}</Text> : null}
      {rating ? <Text color={theme.yellow}>{stars(rating)} ({rating.toFixed(1)})</Text> : null}
    </Box>
  );
});

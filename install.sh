#!/bin/bash
echo "Installing Seepient Agent dependencies..."
pnpm install

echo "Building Seepient Agent..."
pnpm run build

echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "To configure, run:"
echo "  pnpm start -- setup"
echo ""
echo "To use, run:"
echo "  pnpm start"
echo ""

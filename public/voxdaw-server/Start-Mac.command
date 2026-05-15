#!/bin/bash
cd "$(dirname "$0")"
echo "========================================="
echo "      Starting VoxDaw MIDI Bridge..."
echo "========================================="
echo ""
echo "Checking dependencies (this takes a second)..."
npm install --silent
echo ""
echo "Starting Server..."
node server.js
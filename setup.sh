#!/bin/bash

# Photrix Setup Script
# This script sets up the Photrix photo organization and sharing application

set -e

echo "🚀 Setting up Photrix..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 14+ first."
    exit 1
fi

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3 first."
    exit 1
fi

echo "✅ Prerequisites check passed"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo "📦 Installing backend dependencies..."
cd backend
npm install

echo "📦 Setting up environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "🔧 Created .env file. Please review and update as needed."
fi

cd ..

echo "🎉 Setup complete!"
echo ""
echo "To start the application:"
echo "  npm run dev          # Start both frontend and backend"
echo "  npm run dev:backend  # Start backend only (port 3001)"
echo "  npm run dev:frontend # Start frontend only (port 3000)"
echo ""
echo "Then open http://localhost:3000 in your browser"
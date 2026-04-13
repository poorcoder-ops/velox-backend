-- Velox Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  github_id INTEGER UNIQUE,
  github_username TEXT,
  email TEXT,
  access_token TEXT,
  stripe_customer_id TEXT,
  subscription_status TEXT DEFAULT 'free',
  subscription_tier TEXT DEFAULT 'free',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- GitHub Installations table
CREATE TABLE IF NOT EXISTS github_installations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER,
  repository_id BIGINT,
  repository_name TEXT,
  permissions JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  installation_id UUID REFERENCES github_installations(id) ON DELETE SET NULL,
  pull_request_number INTEGER,
  repository TEXT,
  status TEXT DEFAULT 'pending',
  claude_response TEXT,
  issues_found INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Waitlist table
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- API Usage table
CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reviews_count INTEGER DEFAULT 0,
  api_calls_count INTEGER DEFAULT 0,
  period_start TIMESTAMP DEFAULT NOW(),
  period_end TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_repository ON reviews(repository);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_installations_user_id ON github_installations(user_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);

-- Enable Row Level Security (RLS) - optional for extra security
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
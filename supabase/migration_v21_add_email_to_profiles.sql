-- Migration: Add email column to profiles table

ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS email TEXT;

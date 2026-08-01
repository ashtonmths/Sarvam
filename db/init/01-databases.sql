-- Ariadne's own graph store.
CREATE EXTENSION IF NOT EXISTS vector;

-- The seeded demo company. Cartographer crawls these the same way it would
-- crawl a real customer, so nothing in the demo path is mocked.
CREATE DATABASE demo_billing;
CREATE DATABASE n8n;

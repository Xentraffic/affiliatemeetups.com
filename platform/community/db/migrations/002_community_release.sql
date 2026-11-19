-- Additive release schema; do not mutate deployed migration 001.
ALTER TABLE owners ADD COLUMN company_name TEXT NOT NULL DEFAULT '';
ALTER TABLE owners ADD COLUMN consent_version TEXT;
ALTER TABLE owners ADD COLUMN consent_at TEXT;
ALTER TABLE agents ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN interests TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN suspension_by TEXT;
ALTER TABLE agents ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["read","post:write","comment:write","vote","profile:write","follow:write","report:write"]';
ALTER TABLE agents ADD COLUMN credential_expires_at TEXT;
ALTER TABLE agents ADD COLUMN allowed_rooms TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN verification_requested_at TEXT;
ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN rules TEXT NOT NULL DEFAULT 'Share useful, sourced affiliate marketing information. No spam, private data or unauthorized commitments.';
ALTER TABLE rooms ADD COLUMN crypto_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN type TEXT NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN edited_at TEXT;
ALTER TABLE posts ADD COLUMN deleted_at TEXT;
ALTER TABLE posts ADD COLUMN hidden_at TEXT;
ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN accepted_comment_id TEXT;
CREATE TABLE comments(comment_id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(post_id),parent_id TEXT REFERENCES comments(comment_id),agent_id TEXT NOT NULL REFERENCES agents(agent_id),body TEXT NOT NULL,created_at TEXT NOT NULL,edited_at TEXT,deleted_at TEXT,hidden_at TEXT);
CREATE INDEX comments_post ON comments(post_id,created_at);
CREATE TABLE votes(agent_id TEXT NOT NULL REFERENCES agents(agent_id),target_type TEXT NOT NULL CHECK(target_type IN('post','comment')),target_id TEXT NOT NULL,value INTEGER NOT NULL CHECK(value IN(-1,1)),discounted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,target_type,target_id));
CREATE INDEX votes_target ON votes(target_type,target_id);
CREATE TABLE follows(agent_id TEXT NOT NULL REFERENCES agents(agent_id),target_type TEXT NOT NULL CHECK(target_type IN('room','agent')),target_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,target_type,target_id));
CREATE TABLE notifications(notification_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),kind TEXT NOT NULL,target_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT);
CREATE INDEX notifications_agent ON notifications(agent_id,created_at);
CREATE TABLE reports(report_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES owners(owner_id),reporter_agent_id TEXT REFERENCES agents(agent_id),target_type TEXT NOT NULL CHECK(target_type IN('post','comment','agent')),target_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL,UNIQUE(owner_id,target_type,target_id));
CREATE TABLE content_history(history_id TEXT PRIMARY KEY,target_type TEXT NOT NULL,target_id TEXT NOT NULL,body TEXT NOT NULL,title TEXT,edited_at TEXT NOT NULL);
CREATE TABLE audit_log(audit_id TEXT PRIMARY KEY,actor_type TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT,details TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE INDEX audit_actor ON audit_log(actor_type,actor_id,created_at);
CREATE TABLE api_keys(key_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE request_cache(actor_id TEXT NOT NULL,cache_key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(actor_id,cache_key));
CREATE TABLE rate_buckets(bucket TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
CREATE TABLE admin_totp_used(counter INTEGER PRIMARY KEY);
CREATE TABLE moderation_flags(flag_id TEXT PRIMARY KEY,kind TEXT NOT NULL,evidence_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
CREATE TABLE endorsements(from_agent TEXT NOT NULL REFERENCES agents(agent_id),to_agent TEXT NOT NULL REFERENCES agents(agent_id),skill TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(from_agent,to_agent,skill));
CREATE TABLE kudos(kudos_id TEXT PRIMARY KEY,from_agent TEXT NOT NULL REFERENCES agents(agent_id),to_agent TEXT NOT NULL REFERENCES agents(agent_id),body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE bug_reports(bug_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',staff_reply TEXT,created_at TEXT NOT NULL);
CREATE TABLE room_moderators(room_id TEXT NOT NULL REFERENCES rooms(room_id),owner_id TEXT NOT NULL REFERENCES owners(owner_id),PRIMARY KEY(room_id,owner_id));
CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO settings VALUES('post_limit','10'),('comment_limit','60'),('vote_limit','200'),('report_limit','10');
INSERT INTO rooms(room_id,slug,name,created_at,description) VALUES
('room_media','media-buying','Media buying',datetime('now'),'Meta, Google, native, email and campaign operations.'),
('room_offers','offers-partners','Offers & partners',datetime('now'),'Discover approved opportunities and partners.'),
('room_calls','pay-per-call','Pay-per-call',datetime('now'),'Call generation, routing, quality and attribution.'),
('room_telehealth','telehealth-nutra','Telehealth & nutra',datetime('now'),'Evidence, approved creative and responsible campaign operations.'),
('room_creative','creative','Creative & design',datetime('now'),'Show your work. Hooks, landing pages and creative testing.'),
('room_tracking','tracking-data','Tracking & data',datetime('now'),'Attribution, reporting, Everflow and integrations.'),
('room_builders','builders','Agent builders',datetime('now'),'Build with us. Agent tools, workflows and integrations.'),
('room_safety','security-fraud','Security & traffic quality',datetime('now'),'Source quality, fraud controls and operational security.');
CREATE VIRTUAL TABLE search_posts USING fts5(title,body,content='posts',content_rowid='rowid');
INSERT INTO search_posts(search_posts) VALUES('rebuild');
CREATE TRIGGER search_posts_insert AFTER INSERT ON posts BEGIN INSERT INTO search_posts(rowid,title,body) VALUES(new.rowid,new.title,new.body); END;
CREATE TRIGGER search_posts_delete AFTER DELETE ON posts BEGIN INSERT INTO search_posts(search_posts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body); END;
CREATE TRIGGER search_posts_update AFTER UPDATE OF title,body ON posts BEGIN INSERT INTO search_posts(search_posts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body); INSERT INTO search_posts(rowid,title,body) VALUES(new.rowid,new.title,new.body); END;

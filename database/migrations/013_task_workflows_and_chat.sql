-- Migration 013: Task Unified Statuses, Workflows, and Hierarchical Chat

BEGIN;

-- 1. Refine guard_task_project_integrity trigger to safely handle existing/deleted tasks during updates
CREATE OR REPLACE FUNCTION guard_task_project_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_item_project uuid;
  product_project uuid;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NULL THEN
    RAISE EXCEPTION 'المهمة يجب أن تكون مرتبطة بمشروع صالح' USING errcode='23502';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id) THEN
    RAISE EXCEPTION 'المشروع المحدد غير موجود أو محذوف' USING errcode='23503';
  END IF;

  IF NEW.plan_item_id IS NOT NULL THEN
    SELECT project_id INTO plan_item_project FROM master_plan_items WHERE id=NEW.plan_item_id;
    IF plan_item_project IS NOT NULL AND plan_item_project <> NEW.project_id THEN
      RAISE EXCEPTION 'بند الخطة المحدد لا ينتمي إلى المشروع المختار' USING errcode='23514';
    END IF;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT project_id INTO product_project FROM products WHERE id=NEW.product_id;
    IF product_project IS NOT NULL AND product_project <> NEW.project_id THEN
      RAISE EXCEPTION 'المنتج المحدد لا ينتمي إلى المشروع المختار' USING errcode='23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- 2. Safely convert tasks.status and master_plan_items.baseline_status to text
DO $$ BEGIN
  ALTER TABLE tasks ALTER COLUMN status TYPE text USING status::text;
  ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'not_started';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE master_plan_items ALTER COLUMN baseline_status TYPE text USING baseline_status::text;
  ALTER TABLE master_plan_items ALTER COLUMN baseline_status SET DEFAULT 'not_started';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 3. Migrate existing Task statuses to standardized 7 statuses (where not deleted)
UPDATE tasks SET status = 'completed_approved' WHERE status::text IN ('completed', 'approved', 'closed', 'مكتملة', 'معتمدة', 'مغلقة', 'تم التنفيذ', 'Completed', 'Approved', 'Closed', 'Completed & Approved');
UPDATE tasks SET status = 'awaiting_approval' WHERE status::text IN ('waiting_approval', 'awaiting_approval', 'تم التنفيذ - بانتظار الاعتماد', 'Completed – Awaiting Approval');
UPDATE tasks SET status = 'on_hold' WHERE status::text IN ('blocked', 'متعثرة');
UPDATE tasks SET status = 'not_started' WHERE status::text NOT IN ('not_started', 'in_progress', 'on_hold', 'awaiting_approval', 'needs_revision', 'completed_approved', 'cancelled');

-- 3. Add lifecycle tracking columns to tasks table
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS actual_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_submitted_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_approved_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS hold_at timestamptz,
  ADD COLUMN IF NOT EXISTS hold_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expected_resume_at timestamptz,
  ADD COLUMN IF NOT EXISTS original_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS extension_count int NOT NULL DEFAULT 0;

-- Set original_due_at for existing tasks if null
UPDATE tasks SET original_due_at = scheduled_due_at WHERE original_due_at IS NULL AND scheduled_due_at IS NOT NULL;
UPDATE tasks SET original_due_at = due_date::timestamptz WHERE original_due_at IS NULL AND due_date IS NOT NULL;

-- 4. Task Completion Requests Table
CREATE TABLE IF NOT EXISTS task_completion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submitted_by_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  completion_note text,
  deliverable_description text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_percentage numeric(5,2) NOT NULL DEFAULT 100,
  actual_completion_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending_review', -- 'pending_review', 'approved', 'revision_requested', 'returned_to_execution', 'rejected'
  reviewed_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_completion_req_task ON task_completion_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_task_completion_req_status ON task_completion_requests(status);

-- 5. Task Extension Requests Table
CREATE TABLE IF NOT EXISTS task_extension_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  original_due_at timestamptz,
  requested_due_at timestamptz NOT NULL,
  requested_duration_days int,
  reason text NOT NULL,
  notes text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending_review', -- 'pending_review', 'approved', 'rejected', 'needs_info', 'cancelled'
  reviewed_by_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_extension_req_task ON task_extension_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_task_extension_req_status ON task_extension_requests(status);

-- 6. Task Assignment History Table
CREATE TABLE IF NOT EXISTS task_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  previous_assignee_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_assignee_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  new_assignee_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  new_assignee_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reassigned_by_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason text,
  note text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_assign_history_task ON task_assignment_history(task_id);

-- 7. Hierarchical Chat System Tables
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'DIRECT', -- 'DIRECT', 'TASK', 'PROJECT_TEAM'
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES master_plan_items(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  title text,
  created_by_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_task ON chat_conversations(task_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_project ON chat_conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_type ON chat_conversations(type);

CREATE TABLE IF NOT EXISTS chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role_in_conversation text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_conv ON chat_participants(conversation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message text NOT NULL,
  reply_to_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id);

CREATE TABLE IF NOT EXISTS chat_message_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reference_type text NOT NULL, -- 'TASK', 'PROCEDURE', 'SUB_PROCEDURE', 'USER'
  reference_id uuid NOT NULL,
  reference_title text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_refs_msg ON chat_message_references(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_refs_target ON chat_message_references(reference_type, reference_id);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS trg_task_completion_req_updated_at ON task_completion_requests;
CREATE TRIGGER trg_task_completion_req_updated_at BEFORE UPDATE ON task_completion_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_task_extension_req_updated_at ON task_extension_requests;
CREATE TRIGGER trg_task_extension_req_updated_at BEFORE UPDATE ON task_extension_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_chat_conversations_updated_at ON chat_conversations;
CREATE TRIGGER trg_chat_conversations_updated_at BEFORE UPDATE ON chat_conversations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

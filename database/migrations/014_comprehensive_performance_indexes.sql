-- Migration 014: Comprehensive Performance Indexes
-- Accelerate task filtering, procedures, chat, schedule/assignment history, and audit logs.

begin;

-- Task execution procedures & sub-procedures indexes
create index if not exists idx_ep_task_order_active on execution_procedures(task_id, order_index) where deleted_at is null;
create index if not exists idx_ep_status_active on execution_procedures(status) where deleted_at is null;
create index if not exists idx_esp_proc_order_active on execution_sub_procedures(procedure_id, order_index) where deleted_at is null;
create index if not exists idx_esp_task_active on execution_sub_procedures(task_id) where deleted_at is null;
create index if not exists idx_esp_status_active on execution_sub_procedures(status) where deleted_at is null;

-- Chat conversations & messages indexes
create index if not exists idx_chat_conversations_task_id on chat_conversations(task_id);
create index if not exists idx_chat_conversations_type on chat_conversations(type);
create index if not exists idx_chat_participants_user_conv on chat_participants(user_id, conversation_id);
create index if not exists idx_chat_messages_conv_created on chat_messages(conversation_id, created_at desc) where deleted_at is null;
create index if not exists idx_chat_messages_sender on chat_messages(sender_id, created_at desc);

-- Task workflow, history & request indexes
create index if not exists idx_task_assignees_user_task on task_assignees(user_id, task_id);
create index if not exists idx_task_assignees_task_user on task_assignees(task_id, user_id);
create index if not exists idx_task_assign_history_task_time on task_assignment_history(task_id, effective_at desc);
create index if not exists idx_task_sched_history_task_time on task_schedule_history(task_id, changed_at desc);
create index if not exists idx_task_completion_req_task_status on task_completion_requests(task_id, status);
create index if not exists idx_task_extension_req_task_status on task_extension_requests(task_id, status);

-- Task project & hierarchy lookups
create index if not exists idx_tasks_project_status_due on tasks(project_id, status, due_date) where deleted_at is null;
create index if not exists idx_tasks_plan_item_id on tasks(plan_item_id) where deleted_at is null;
create index if not exists idx_master_plan_items_project_track on master_plan_items(project_id, track) where deleted_at is null;

-- Activity and audit log indexes
create index if not exists idx_activity_log_entity on activity_log(entity_table, entity_id);
create index if not exists idx_activity_log_actor_time on activity_log(actor_id, created_at desc);

commit;

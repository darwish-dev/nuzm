import type { AppSpec } from '../spec/app-spec';

/** A small valid spec used by unit/integration tests (NOT the reference CRM): a task tracker with two entities and two roles. */
export const SAMPLE_SPEC: AppSpec = {
  name: 'Task Tracker',
  slug: 'task-tracker',
  description: 'Teams track projects and their tasks.',
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  entities: [
    {
      name: 'Project',
      plural: 'projects',
      labels: { ar: 'مشروع', en: 'Project' },
      ownership: 'org',
      audit: true,
      searchable: ['name'],
      sortable: ['name'],
      fields: [
        {
          name: 'name',
          type: 'string',
          labels: { ar: 'الاسم', en: 'Name' },
          required: true,
          maxLength: 120,
        },
        {
          name: 'status',
          type: 'enum',
          labels: { ar: 'الحالة', en: 'Status' },
          required: true,
          enumValues: ['Active', 'Archived'],
        },
      ],
    },
    {
      name: 'Task',
      plural: 'tasks',
      labels: { ar: 'مهمة', en: 'Task' },
      ownership: 'owner',
      audit: true,
      searchable: ['title'],
      sortable: ['title', 'dueDate'],
      stageField: 'stage',
      fields: [
        {
          name: 'title',
          type: 'string',
          labels: { ar: 'العنوان', en: 'Title' },
          required: true,
          maxLength: 200,
        },
        {
          name: 'stage',
          type: 'enum',
          labels: { ar: 'المرحلة', en: 'Stage' },
          required: true,
          enumValues: ['Todo', 'Doing', 'Done'],
        },
        { name: 'dueDate', type: 'date', labels: { ar: 'تاريخ الاستحقاق', en: 'Due date' } },
        {
          name: 'project',
          type: 'reference',
          references: 'Project',
          labels: { ar: 'المشروع', en: 'Project' },
        },
        {
          name: 'assigneeEmail',
          type: 'email',
          pii: true,
          labels: { ar: 'بريد المسؤول', en: 'Assignee email' },
        },
      ],
    },
  ],
  roles: [
    {
      name: 'admin',
      labels: { ar: 'مدير', en: 'Admin' },
      scope: 'all',
      admin: true,
      permissions: {
        Project: ['create', 'read', 'update', 'delete', 'export'],
        Task: ['create', 'read', 'update', 'delete', 'export', 'import'],
      },
    },
    {
      name: 'member',
      labels: { ar: 'عضو', en: 'Member' },
      scope: 'own',
      permissions: { Project: ['read'], Task: ['create', 'read', 'update'] },
    },
  ],
  pages: [
    {
      path: '/projects',
      kind: 'list',
      entity: 'Project',
      title: { ar: 'المشاريع', en: 'Projects' },
    },
    { path: '/tasks', kind: 'list', entity: 'Task', title: { ar: 'المهام', en: 'Tasks' } },
    { path: '/board', kind: 'board', entity: 'Task', title: { ar: 'اللوحة', en: 'Board' } },
    {
      path: '/',
      kind: 'dashboard',
      title: { ar: 'الرئيسية', en: 'Home' },
      widgets: [
        {
          id: 'open_tasks',
          kind: 'count',
          entity: 'Task',
          title: { ar: 'المهام المفتوحة', en: 'Open tasks' },
        },
      ],
    },
  ],
  api: { basePath: '/api/v1', defaultLimit: 25, maxLimit: 100 },
  nonFunctional: {
    rtl: true,
    accessibility: 'WCAG2.1-AA',
    dataRegion: 'sa-central',
    csvImportExport: true,
    attachmentMaxBytes: 10485760,
    notifications: [],
  },
};

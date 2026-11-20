// Public surface of the knowledge module (AI Intelligence Center, ADR-065).
export { KnowledgeModule } from './knowledge.module';
export { ResourceService } from './internal/resource.service';
export { UploadService } from './internal/upload.service';
export { KnowledgeObjectStore, FsObjectStore } from './internal/object-store';
export {
  KNOWLEDGE_LIBRARY_FLAG,
  KNOWLEDGE_CUSTOMER_TEMPLATES_FLAG,
  KNOWLEDGE_IMPORT_PROJECTS_FLAG,
  KNOWLEDGE_SEMANTIC_SEARCH_FLAG,
} from './internal/flag';

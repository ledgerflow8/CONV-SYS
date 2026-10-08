// Creates (or updates) the private "resources" bucket in Supabase: npm run storage:setup
import { MAX_UPLOAD_BYTES, RESOURCE_BUCKET, storage } from "../src/lib/storage";

storage()
  .ensureBucket()
  .then(() => console.log(`Bucket "${RESOURCE_BUCKET}" ready: private, max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per file.`))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

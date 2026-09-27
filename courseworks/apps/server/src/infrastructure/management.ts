import {
  archiveAndDeleteHomeworksUsers,
  archiveAndDeleteManagedUsers,
  configureAccountArchiveService,
  configureHomeworksAccountStore,
  deleteHomeworksInviteCode,
  syncHomeworksInviteCode,
  syncHomeworksInviteCodeStatus,
  syncHomeworksInviteCodeUsage,
  syncHomeworksUser,
} from "@all-together/management";

import { config } from "../config/index.js";
import { resetWorkspaceLabSessions } from "../modules/execution/index.js";
import { syncWorkspaceMatchFile } from "../modules/workspaces/index.js";
import { prisma } from "./prisma/client.js";

configureHomeworksAccountStore({
  accountDatabasePath: config.HOMEWORKS_ACCOUNT_DATABASE_PATH,
  courseDatabasePath: config.HOMEWORKS_COURSE_DATABASE_PATH,
  uploadPath: config.HOMEWORKS_UPLOAD_PATH,
  slideshowDatabasePath: config.SLIDESHOW_DATABASE_PATH,
});

configureAccountArchiveService({
  prisma,
  archiveRoot: config.ARCHIVE_ROOT,
  workspaceRoot: config.WORKSPACE_ROOT,
  archiveAndDeleteHomeworksUsers,
  syncHomeworksInviteCodeUsage,
  resetWorkspaceLabSessions,
  syncWorkspaceMatchFile,
});

export {
  archiveAndDeleteManagedUsers,
  deleteHomeworksInviteCode,
  syncHomeworksInviteCode,
  syncHomeworksInviteCodeStatus,
  syncHomeworksInviteCodeUsage,
  syncHomeworksUser,
};

-- Destructive rollback of issue 865 ONLY, after exporting workflow metadata.
-- Never reactivate legacy resolve/reject/expiry writers as part of rollback.
DROP TABLE "DisputeWorkflow";

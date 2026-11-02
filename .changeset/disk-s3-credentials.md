---
"disk": minor
"@archildata/python": minor
---

`createS3Credentials` and `removeS3Credentials` (`create_s3_credentials` and `remove_s3_credentials` in Python) create and revoke access keys for a disk's S3 API, with an optional nickname, expiry, and read-only flag. `addUser` accepts an `S3User`, `removeUser` accepts the `s3` user type, and an `AuthorizedUser` carries `s3AccessKeyId` and `s3SecretKey`.

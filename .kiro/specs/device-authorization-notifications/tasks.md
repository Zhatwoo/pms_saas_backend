# Implementation Plan: Device Authorization Notifications

## Overview

This implementation adds automatic notifications to super admins when employees request device authorization. The feature integrates notification creation into the existing `DevicesService.requestAuthorization()` method using a fire-and-forget asynchronous pattern. Notification failures are logged but do not impact the authorization flow.

**Key Design Principles:**
- Asynchronous, non-blocking notification creation
- Fire-and-forget pattern for minimal performance impact
- Graceful error handling with comprehensive logging
- Deduplication via event keys

## Tasks

- [x] 1. Add NotificationsService dependency to DevicesService
  - Import `NotificationsService` from `src/modules/notifications/services/notifications.service.ts`
  - Add `notificationsService` parameter to `DevicesService` constructor
  - Import `Logger` from `@nestjs/common` if not already present
  - Add `Logger` instance to constructor if not already present
  - Verify `NotificationsModule` is marked as `@Global()` (should already be configured)
  - _Requirements: 1.1, 5.4_

- [x] 2. Implement notification creation method
  - [x] 2.1 Create private async method `notifyDeviceAuthorizationRequest` in DevicesService
    - Accept parameters: `deviceId`, `deviceFingerprint`, `deviceName`, `deviceType`, `ipAddress`, `employeeId`, `branchId`, `environment`
    - Add try-catch block for error handling
    - Return `Promise<void>`
    - _Requirements: 1.1, 1.2, 5.1_

  - [x] 2.2 Add employee context fetching logic
    - Use `this.prisma.users.findUnique()` to fetch employee by `employeeId`
    - Select fields: `id`, `full_name`, `email`, `branch_id`
    - Return early with warning log if employee not found
    - _Requirements: 2.1, 2.2, 5.3_

  - [x] 2.3 Build notification message
    - Construct message with device name, device type, employee full name, employee email
    - Conditionally include IP address if present
    - Join message lines with newline separator
    - _Requirements: 2.2, 2.7_

  - [x] 2.4 Create notification payload
    - Set title: `"Device Authorization Request from {employee.full_name}"`
    - Set category to `"Requests"`
    - Set entity_type to `"system"`
    - Set entity_id to device ID
    - Set event_key to `"device_auth_request:{deviceId}"`
    - Set target_role to `Role.SUPER_ADMIN`
    - Set user_id to `null`
    - Set branch_id from device request
    - Set environment from device request
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 4.1, 4.2, 4.3_

  - [x] 2.5 Call NotificationsService.create()
    - Call `await this.notificationsService.create(payload)`
    - Wrap in try-catch to handle errors
    - Log errors with device ID, employee ID, and error message
    - _Requirements: 1.1, 5.1, 5.2, 5.3_

  - [ ]* 2.6 Write property test for notification payload completeness
    - **Property 1: Notification payload completeness**
    - Generate random device authorization contexts with varying presence of optional fields (branch_id, ip_address)
    - Mock employee details lookup
    - Verify all required fields are present: title, message, category, entity_type, entity_id, event_key, target_role, user_id, environment
    - Verify conditional fields (branch_id, IP in message) are correctly handled
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 4.3**

  - [ ]* 2.7 Write property test for event key format consistency
    - **Property 2: Event key format consistency**
    - Generate random device IDs
    - Verify event key always matches pattern `device_auth_request:{device_id}`
    - Test with various device ID formats (UUIDs, alphanumeric strings)
    - **Validates: Requirements 3.1, 3.3**

- [x] 3. Integrate notification into requestAuthorization() for new device creation
  - Locate the code block where new device is created via `this.prisma.authorized_devices.create()`
  - After device creation, call `this.notifyDeviceAuthorizationRequest()` with device fields
  - Use fire-and-forget pattern: append `.catch(() => {})` to the notification promise
  - Ensure device record is returned immediately without waiting for notification
  - _Requirements: 1.1, 1.2, 1.4_

- [x] 4. Integrate notification into requestAuthorization() for existing device update
  - Locate the code block where existing device is updated via `this.prisma.authorized_devices.update()`
  - After device update, call `this.notifyDeviceAuthorizationRequest()` with device fields
  - Use fire-and-forget pattern: append `.catch(() => {})` to the notification promise
  - Ensure device record is returned immediately without waiting for notification
  - _Requirements: 1.1, 1.2, 1.4_

- [x] 5. Add unit tests for error handling scenarios
  - [x] 5.1 Test employee not found scenario
    - Mock `prisma.users.findUnique()` to return null
    - Verify warning is logged with employee ID
    - Verify method returns early without calling NotificationsService
    - _Requirements: 5.1, 5.3_

  - [x] 5.2 Test notification service failure
    - Mock `notificationsService.create()` to throw exception
    - Verify error is caught and logged with device ID, employee ID, and error message
    - Verify error is not propagated
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 5.3 Test authorization completes when notification fails
    - Mock notification creation to throw exception
    - Call `requestAuthorization()` and verify it returns device record successfully
    - Verify response is not delayed by notification failure
    - _Requirements: 1.3, 1.4, 5.2, 5.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Run all unit tests and property tests
  - Verify no linting errors
  - Verify TypeScript compilation succeeds
  - Ask the user if questions arise

- [ ]* 7. Integration testing
  - [ ]* 7.1 Test end-to-end notification creation
    - Create a device authorization request via API
    - Verify notification is created with correct payload
    - Verify notification is visible to super admins
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2_

  - [ ]* 7.2 Test deduplication
    - Submit the same device authorization request twice
    - Verify only one notification exists with the given event_key
    - _Requirements: 3.1, 3.2_

  - [ ]* 7.3 Test environment isolation
    - Create device requests in production and development environments
    - Verify notifications are scoped to correct environment
    - Verify super admins only see notifications for their environment
    - _Requirements: 4.3, 4.4_

- [x] 8. Final checkpoint - Review and verify
  - Review code for adherence to NestJS best practices
  - Verify all error paths are logged appropriately
  - Verify asynchronous execution does not block authorization flow
  - Ensure all tests pass
  - Ask the user if questions arise

## Task Dependency Graph

```
1 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 3
                              2.5 → 4
                              2.5 → 5.1
                              2.5 → 5.2
3 → 5.3
4 → 5.3
5.1 → 6
5.2 → 6
5.3 → 6
6 → 8
2.6 (optional)
2.7 (optional)
7.1 (optional)
7.2 (optional)
7.3 (optional)
```

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The notification system already handles deduplication via event_key, so no additional deduplication logic is needed in DevicesService
- NotificationsModule is already global, so no module imports are required
- All async notification calls use fire-and-forget pattern with `.catch()` to prevent unhandled promise rejections
- Property tests should use at least 100 iterations to ensure comprehensive coverage
- Integration tests require running database and can be run separately from unit tests

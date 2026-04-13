package com.swp391.datalabeling.controller;

import com.swp391.datalabeling.dto.request.AnnotationRequest;
import com.swp391.datalabeling.dto.request.ReviewRequest;
import com.swp391.datalabeling.dto.request.TaskAssignRequest;
import com.swp391.datalabeling.dto.response.ApiResponse;
import com.swp391.datalabeling.entity.Review;
import com.swp391.datalabeling.entity.Task;
import com.swp391.datalabeling.service.TaskService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class TaskController {

    private final TaskService taskService;

    // Manager assigns tasks
    @PostMapping("/manager/tasks/assign")
    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
    public ResponseEntity<ApiResponse<Task>> assignTask(@Valid @RequestBody TaskAssignRequest request) {
        return ResponseEntity.ok(ApiResponse.success("Task assigned", taskService.assignTask(request)));
    }

    // Manager views all tasks for a project
    @GetMapping("/manager/projects/{projectId}/tasks")
    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
    public ResponseEntity<ApiResponse<List<Task>>> getTasksByProject(@PathVariable Long projectId) {
        return ResponseEntity.ok(ApiResponse.success(taskService.getTasksByProject(projectId)));
    }

    // Annotator views their tasks
    @GetMapping("/annotator/tasks")
    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER', 'ANNOTATOR')")
    public ResponseEntity<ApiResponse<List<Task>>> getMyTasks(@AuthenticationPrincipal UserDetails userDetails) {
        // Get user id from username - simplified here
        return ResponseEntity.ok(ApiResponse.success(taskService.getTasksByAnnotator(null)));
    }

    // Annotator submits a task with annotations
    @PostMapping("/annotator/tasks/{taskId}/submit")
    @PreAuthorize("hasAnyRole('ANNOTATOR', 'ADMIN')")
    public ResponseEntity<ApiResponse<Task>> submitTask(
            @PathVariable Long taskId,
            @RequestBody List<@Valid AnnotationRequest> annotations,
            @AuthenticationPrincipal UserDetails userDetails
    ) {
        Task task = taskService.submitTask(taskId, annotations, userDetails.getUsername());
        return ResponseEntity.ok(ApiResponse.success("Task submitted for review", task));
    }

    // Reviewer gets submitted tasks
    @GetMapping("/reviewer/tasks/submitted")
    @PreAuthorize("hasAnyRole('REVIEWER', 'ADMIN', 'MANAGER')")
    public ResponseEntity<ApiResponse<List<Task>>> getSubmittedTasks() {
        return ResponseEntity.ok(ApiResponse.success(taskService.getSubmittedTasks()));
    }

    // Reviewer reviews a task
    @PostMapping("/reviewer/tasks/{taskId}/review")
    @PreAuthorize("hasAnyRole('REVIEWER', 'ADMIN', 'MANAGER')")
    public ResponseEntity<ApiResponse<Review>> reviewTask(
            @PathVariable Long taskId,
            @Valid @RequestBody ReviewRequest request,
            @AuthenticationPrincipal UserDetails userDetails
    ) {
        Review review = taskService.reviewTask(taskId, request, userDetails.getUsername());
        return ResponseEntity.ok(ApiResponse.success("Review submitted", review));
    }
}

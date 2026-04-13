package com.swp391.datalabeling.controller;

import com.swp391.datalabeling.dto.request.ProjectRequest;
import com.swp391.datalabeling.dto.response.ApiResponse;
import com.swp391.datalabeling.entity.Project;
import com.swp391.datalabeling.enums.ProjectStatus;
import com.swp391.datalabeling.service.ProjectService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/manager/projects")
@RequiredArgsConstructor
@PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
public class ProjectController {

    private final ProjectService projectService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<Project>>> getAllProjects() {
        return ResponseEntity.ok(ApiResponse.success(projectService.getAllProjects()));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<Project>> getProject(@PathVariable Long id) {
        return ResponseEntity.ok(ApiResponse.success(projectService.getProjectById(id)));
    }

    @GetMapping("/my")
    public ResponseEntity<ApiResponse<List<Project>>> getMyProjects(@AuthenticationPrincipal UserDetails userDetails) {
        // Get projects by manager username
        return ResponseEntity.ok(ApiResponse.success(
                projectService.getProjectsByManager(null) // handled by manager username in service
        ));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<Project>> createProject(
            @Valid @RequestBody ProjectRequest request,
            @AuthenticationPrincipal UserDetails userDetails
    ) {
        Project project = projectService.createProject(request, userDetails.getUsername());
        return ResponseEntity.ok(ApiResponse.success("Project created", project));
    }

    @PutMapping("/{id}")
    public ResponseEntity<ApiResponse<Project>> updateProject(
            @PathVariable Long id,
            @Valid @RequestBody ProjectRequest request
    ) {
        return ResponseEntity.ok(ApiResponse.success("Project updated", projectService.updateProject(id, request)));
    }

    @PutMapping("/{id}/status")
    public ResponseEntity<ApiResponse<Project>> updateStatus(
            @PathVariable Long id,
            @RequestParam ProjectStatus status
    ) {
        return ResponseEntity.ok(ApiResponse.success(projectService.updateStatus(id, status)));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> deleteProject(@PathVariable Long id) {
        projectService.deleteProject(id);
        return ResponseEntity.ok(ApiResponse.success("Project deleted", null));
    }
}

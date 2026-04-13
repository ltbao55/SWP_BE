package com.swp391.datalabeling.service;

import com.swp391.datalabeling.dto.request.ProjectRequest;
import com.swp391.datalabeling.entity.Project;
import com.swp391.datalabeling.entity.User;
import com.swp391.datalabeling.enums.ProjectStatus;
import com.swp391.datalabeling.exception.ResourceNotFoundException;
import com.swp391.datalabeling.repository.ProjectRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ProjectService {

    private final ProjectRepository projectRepository;
    private final UserService userService;

    public List<Project> getAllProjects() {
        return projectRepository.findAll();
    }

    public Project getProjectById(Long id) {
        return projectRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Project", id));
    }

    public List<Project> getProjectsByManager(Long managerId) {
        return projectRepository.findByManagerId(managerId);
    }

    @Transactional
    public Project createProject(ProjectRequest request, String managerUsername) {
        User manager = userService.getUserByUsername(managerUsername);
        Project project = Project.builder()
                .name(request.getName())
                .description(request.getDescription())
                .labelingGuideline(request.getLabelingGuideline())
                .manager(manager)
                .build();
        return projectRepository.save(project);
    }

    @Transactional
    public Project updateProject(Long id, ProjectRequest request) {
        Project project = getProjectById(id);
        project.setName(request.getName());
        if (request.getDescription() != null) project.setDescription(request.getDescription());
        if (request.getLabelingGuideline() != null) project.setLabelingGuideline(request.getLabelingGuideline());
        return projectRepository.save(project);
    }

    @Transactional
    public Project updateStatus(Long id, ProjectStatus status) {
        Project project = getProjectById(id);
        project.setStatus(status);
        return projectRepository.save(project);
    }

    @Transactional
    public void deleteProject(Long id) {
        projectRepository.deleteById(id);
    }
}

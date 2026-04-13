package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.Project;
import com.swp391.datalabeling.entity.User;
import com.swp391.datalabeling.enums.ProjectStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ProjectRepository extends JpaRepository<Project, Long> {
    List<Project> findByManager(User manager);
    List<Project> findByStatus(ProjectStatus status);
    List<Project> findByManagerId(Long managerId);
}

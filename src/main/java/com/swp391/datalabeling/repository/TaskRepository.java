package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.Task;
import com.swp391.datalabeling.enums.TaskStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface TaskRepository extends JpaRepository<Task, Long> {
    List<Task> findByAssignedToId(Long userId);
    List<Task> findByStatus(TaskStatus status);
    List<Task> findByAssignedToIdAndStatus(Long userId, TaskStatus status);

    @Query("SELECT t FROM Task t JOIN t.dataItem di JOIN di.dataset ds WHERE ds.project.id = :projectId")
    List<Task> findByProjectId(@Param("projectId") Long projectId);
}
